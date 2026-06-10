import fs from "node:fs";
import zlib from "node:zlib";

const ROOT = new URL("../", import.meta.url);
const RESULTS_PDF = new URL("../DIA 3 PUNTA CANA GRAND PRIX 2026.pdf", import.meta.url);
const DIPLOMAS_PDF = new URL("../DIPLOMAS.pdf", import.meta.url);
const OUT = new URL("../assets/data.js", import.meta.url);

const CATEGORY_RE = /^(OPEN|MASTER|PRE-MASTER|RECREATIVA)/i;

function decodePdfLiteral(source) {
  const unescaped = source.replace(/\\([nrtbf()\\])/g, (_, c) => ({
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
    "(": "(",
    ")": ")",
    "\\": "\\",
  })[c]);

  return decodeMaybeUtf16(Buffer.from(unescaped, "latin1"));
}

function decodeMaybeUtf16(bytes) {
  let evenZeros = 0;
  const pairs = Math.floor(bytes.length / 2);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    if (bytes[i] === 0) evenZeros += 1;
  }

  if (pairs && evenZeros / pairs > 0.4) {
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
  }

  return bytes.toString("latin1");
}

function decodeHex(hex) {
  const clean = hex.replace(/\s+/g, "");
  const padded = clean.length % 2 ? `${clean}0` : clean;
  const bytes = [];
  for (let i = 0; i < padded.length; i += 2) {
    bytes.push(Number.parseInt(padded.slice(i, i + 2), 16));
  }
  return decodeMaybeUtf16(Buffer.from(bytes));
}

function normalizeEmbeddedText(text) {
  let value = text.trim();

  if (/[\u0000-\u001f]/.test(value) && /[a-z]/.test(value)) {
    value = value.replace(/[\u0000-\u001f]/g, " ");
  } else if (/[\u0000-\u001f$]/.test(value) || /^[0-9][A-Z]/.test(value)) {
    const shifted = [...value]
      .map((char) => {
        const code = char.charCodeAt(0);
        return code < 96 ? String.fromCharCode(code + 29) : char;
      })
      .join("");

    if (/[A-Za-z0-9.]/.test(shifted) && !/[\u0000-\u001f]/.test(shifted)) {
      value = shifted;
    }
  }

  return value
    .replace(/\s+/g, " ")
    .replace(/\s+\./g, ".")
    .trim();
}

function parsePdfObjects(fileUrl) {
  const buffer = fs.readFileSync(fileUrl);
  const latin = buffer.toString("latin1");
  const objects = new Map();
  const re = /(\d+)\s+0\s+obj\s*([\s\S]*?)\s*endobj/g;
  let match;

  while ((match = re.exec(latin))) {
    const id = Number(match[1]);
    const body = match[2];
    const streamMarker = body.indexOf("stream");
    let dict = body;
    let streamData = null;

    if (streamMarker >= 0) {
      dict = body.slice(0, streamMarker);
      let streamStart = match.index + match[0].indexOf("stream") + "stream".length;
      if (latin[streamStart] === "\r" && latin[streamStart + 1] === "\n") streamStart += 2;
      else if (latin[streamStart] === "\n") streamStart += 1;

      const streamEnd = latin.indexOf("endstream", streamStart);
      streamData = buffer.slice(streamStart, streamEnd);
      if (streamData.at(-1) === 10) streamData = streamData.slice(0, -1);
      if (streamData.at(-1) === 13) streamData = streamData.slice(0, -1);
    }

    objects.set(id, { id, body, dict, streamData });
  }

  return objects;
}

function getStreamText(object) {
  if (!object?.streamData) return "";
  let data = object.streamData;
  if (/FlateDecode/.test(object.dict)) {
    try {
      data = zlib.inflateSync(data);
    } catch {
      return "";
    }
  }
  return data.toString("latin1");
}

function refsInContents(dict) {
  const match = dict.match(/\/Contents\s*(\[[^\]]+\]|\d+\s+0\s+R)/s);
  if (!match) return [];
  return [...match[1].matchAll(/(\d+)\s+0\s+R/g)].map((item) => Number(item[1]));
}

function tokenizePdfContent(source) {
  const tokens = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (char === "(") {
      let j = i + 1;
      let depth = 1;
      let out = "";
      while (j < source.length && depth > 0) {
        const next = source[j++];
        if (next === "\\") {
          out += next + (source[j++] || "");
          continue;
        }
        if (next === "(") depth += 1;
        if (next === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
        out += next;
      }
      tokens.push({ type: "str", value: normalizeEmbeddedText(decodePdfLiteral(out)) });
      i = j;
      continue;
    }

    if (char === "<") {
      if (source[i + 1] === "<") {
        tokens.push({ type: "op", value: "<<" });
        i += 2;
        continue;
      }
      const j = source.indexOf(">", i + 1);
      if (j < 0) break;
      tokens.push({ type: "str", value: normalizeEmbeddedText(decodeHex(source.slice(i + 1, j))) });
      i = j + 1;
      continue;
    }

    if (char === "[" || char === "]") {
      tokens.push({ type: "op", value: char });
      i += 1;
      continue;
    }

    let j = i;
    while (j < source.length && !/\s|[\[\]<>()]/.test(source[j])) j += 1;
    const raw = source.slice(i, j);
    const num = Number(raw);
    tokens.push(Number.isFinite(num) && /^[-+]?\d*\.?\d+/.test(raw)
      ? { type: "num", value: num }
      : { type: "op", value: raw });
    i = j;
  }

  return tokens;
}

function extractTextItems(content, pageId, contentId) {
  const tokens = tokenizePdfContent(content);
  const items = [];
  let stack = [];
  let inText = false;
  let x = 0;
  let y = 0;

  for (const token of tokens) {
    if (token.type === "num" || token.type === "str") {
      stack.push(token);
      continue;
    }

    const op = token.value;
    if (op === "BT") {
      inText = true;
      x = 0;
      y = 0;
      stack = [];
      continue;
    }

    if (op === "ET") {
      inText = false;
      stack = [];
      continue;
    }

    if (!inText) {
      stack = [];
      continue;
    }

    if (op === "Td" || op === "TD") {
      const dy = stack.pop();
      const dx = stack.pop();
      if (dx?.type === "num" && dy?.type === "num") {
        x += dx.value;
        y += dy.value;
      }
      stack = [];
      continue;
    }

    if (op === "Tm") {
      const f = stack.pop();
      const e = stack.pop();
      stack.splice(-4);
      if (e?.type === "num" && f?.type === "num") {
        x = e.value;
        y = f.value;
      }
      stack = [];
      continue;
    }

    if (op === "Tj" || op === "'") {
      const text = stack.pop();
      if (text?.type === "str" && text.value) items.push({ pageId, contentId, x, y, text: text.value });
      stack = [];
      continue;
    }

    if (op === "TJ") {
      const text = stack.filter((part) => part.type === "str").map((part) => part.value).join("");
      if (text.trim()) items.push({ pageId, contentId, x, y, text: normalizeEmbeddedText(text) });
      stack = [];
      continue;
    }

    stack = [];
  }

  return items;
}

function pdfPages(objects) {
  const pages = [];
  for (const object of objects.values()) {
    if (/\/Type\s*\/Page\b/.test(object.dict)) {
      const refs = refsInContents(object.dict);
      const items = refs.flatMap((contentId) => extractTextItems(getStreamText(objects.get(contentId)), object.id, contentId));
      pages.push({ id: object.id, refs, items });
    }
  }
  return pages.sort((a, b) => a.id - b.id);
}

function keyName(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function groupRows(items) {
  const rows = [];
  for (const item of items) {
    if (!item.text || /^PUNTA CANA|^DIA 3|^Clasificaci/i.test(item.text)) continue;
    let row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 2);
    if (!row) {
      row = { y: item.y, cells: [] };
      rows.push(row);
    }
    row.cells.push(item);
    row.y = row.cells.reduce((sum, cell) => sum + cell.y, 0) / row.cells.length;
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => ({ y: row.y, cells: row.cells.sort((a, b) => a.x - b.x) }));
}

function isCategory(text) {
  return CATEGORY_RE.test(text) && !/PUNTOS|PUESTO|DORSAL|NOMBRE|EQUIPO|CLUB|TOTAL/i.test(text);
}

function extractRankings(pages, pageIds, type, startingCategory = "") {
  const rows = [];
  let category = startingCategory;
  const counters = new Map();

  for (const pageId of pageIds) {
    for (const row of groupRows(pages.find((page) => page.id === pageId)?.items || [])) {
      const textLine = row.cells.map((cell) => cell.text).join(" ");
      if (/CLASIFICACION|Puesto|Dorsal|Pais|Nombre|Equipo|Club|TOTAL|Distancia|Vel\.|Tiempo|Circuito/i.test(textLine)) continue;

      const categoryCell = row.cells.find((cell) => cell.x < 30 && isCategory(cell.text));
      if (categoryCell) {
        category = categoryCell.text;
        if (!counters.has(category)) counters.set(category, 0);
        continue;
      }

      const nameParts = row.cells.filter((cell) => cell.x >= 120 && cell.x < 335).map((cell) => cell.text);
      const teamParts = row.cells.filter((cell) => cell.x >= 335 && cell.x < 500).map((cell) => cell.text);
      const totalCell = [...row.cells].reverse().find((cell) => cell.x >= 480 && /\d/.test(cell.text));
      const dorsal = row.cells
        .filter((cell) => cell.x >= 45 && cell.x < 120 && /^\d+$/.test(cell.text))
        .map((cell) => cell.text)
        .join("");
      const positionText = row.cells
        .filter((cell) => cell.x < 45 && /\d/.test(cell.text))
        .map((cell) => cell.text)
        .join("");

      const name = nameParts.join(" ").trim();
      const total = Number((totalCell?.text || "").match(/\d+/)?.[0] || 0);
      if (!category || !name || !total) continue;

      const previous = counters.get(category) || 0;
      const position = Number(positionText.match(/\d+/)?.[0] || previous + 1);
      counters.set(category, Math.max(previous + 1, position));

      rows.push({
        type,
        category,
        position,
        dorsal,
        name,
        team: teamParts.join(" ").replace(/\s+/g, " ").trim(),
        points: total,
      });
    }
  }

  return rows;
}

function extractDiplomas(pages) {
  return pages.map((page, index) => {
    const texts = page.items.map((item) => item.text).filter(Boolean);
    const name = texts[3] || "";
    const categoryMarker = texts.findIndex((text) => text === "DE LA CATEGORIA");
    const category = categoryMarker >= 0 ? texts[categoryMarker + 1] || "" : "";
    const dorsal = categoryMarker >= 0 ? texts[categoryMarker + 2] || "" : "";

    return {
      page: index + 1,
      pageId: page.id,
      name,
      category,
      dorsal,
      key: keyName(`${name} ${category}`),
      nameKey: keyName(name),
    };
  }).filter((item) => item.name && item.category);
}

function enrichWithDiplomas(rows, diplomas) {
  const byNameCategory = new Map(diplomas.map((item) => [item.key, item]));
  const byName = new Map(diplomas.map((item) => [item.nameKey, item]));
  const byDorsalCategory = new Map(diplomas.map((item) => [`${item.category}::${item.dorsal}`, item]));

  return rows.map((row) => {
    const diploma = byNameCategory.get(keyName(`${row.name} ${row.category}`))
      || byName.get(keyName(row.name))
      || byDorsalCategory.get(`${row.category}::${row.dorsal}`);
    return {
      ...row,
      name: row.name.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim(),
      team: row.team.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim(),
      dorsal: row.dorsal || diploma?.dorsal || "",
      diplomaPage: diploma?.page || null,
      diplomaName: diploma?.name || "",
    };
  });
}

function applyKnownCorrections(rows) {
  const masterB = [
    [1, "437", "Jonathan García", "Pegacol-V2C", 30],
    [2, "421", "Carlos Ospina", "BMC Metriatools", 26],
    [3, "413", "Ernesto Antonio Rodríguez Villegas", "Act", 24],
    [4, "441", "Rafael Del Sol", "City Bike Rost", 20],
    [5, "415", "Roberto Diaz Moleroo", "Act", 20],
    [6, "405", "Orlay Gonzalez", "Bike Zone Punta Cana", 20],
    [7, "438", "Nortton Sánchez", "Pegacol-V2C", 17],
    [8, "403", "Deivy Capellan", "Bikezone Cycling Team", 17],
    [9, "423", "José Rogelio Candelier", "AR Cycling Team", 17],
    [10, "430", "Aneudy De Jesús", "Hamakan", 15],
    [11, "440", "Mitchel Suárez Puig", "Drinks Team", 15],
    [12, "426", "Franklin Cruz", "Gallo Pelon", 13],
  ].map(([position, dorsal, name, team, points]) => ({
    type: "puntos",
    category: "MASTER B (40-49)",
    position,
    dorsal,
    name,
    team,
    points,
  }));

  return [
    ...rows.filter((row) => !(row.type === "puntos" && row.category === "MASTER B (40-49)")),
    ...masterB,
  ];
}

const resultPages = pdfPages(parsePdfObjects(RESULTS_PDF));
const diplomaPages = pdfPages(parsePdfObjects(DIPLOMAS_PDF));
const diplomas = extractDiplomas(diplomaPages);

const volanteRows = extractRankings(resultPages, [3, 7], "volantes");
const pointsRows = applyKnownCorrections(extractRankings(resultPages, [27, 23, 25], "puntos"));
const athletes = enrichWithDiplomas([...pointsRows, ...volanteRows], diplomas);

const categories = [...new Set(athletes.map((row) => row.category))].sort((a, b) => a.localeCompare(b, "es"));

const payload = {
  generatedAt: new Date().toISOString(),
  source: {
    resultsPdf: decodeURIComponent(RESULTS_PDF.pathname.split("/").pop()),
    diplomasPdf: decodeURIComponent(DIPLOMAS_PDF.pathname.split("/").pop()),
  },
  categories,
  diplomas,
  rankings: {
    puntos: athletes.filter((row) => row.type === "puntos"),
    volantes: athletes.filter((row) => row.type === "volantes"),
  },
};

fs.writeFileSync(
  OUT,
  `window.GRAND_PRIX_DATA = ${JSON.stringify(payload, null, 2)};\n`,
  "utf8",
);

console.log(`Datos generados: ${payload.rankings.puntos.length} filas de puntos, ${payload.rankings.volantes.length} filas de metas volantes, ${diplomas.length} diplomas.`);
