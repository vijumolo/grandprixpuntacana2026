const data = window.GRAND_PRIX_DATA;
const state = {
  ranking: "puntos",
  category: "Todas",
  search: "",
  selected: null,
};

const categoryFilter = document.querySelector("#categoryFilter");
const searchFilter = document.querySelector("#searchFilter");
const resultsBody = document.querySelector("#resultsBody");
const resultCount = document.querySelector("#resultCount");
const rankingTitle = document.querySelector("#rankingTitle");
const diplomaName = document.querySelector("#diplomaName");
const diplomaMeta = document.querySelector("#diplomaMeta");
const diplomaFrame = document.querySelector("#diplomaFrame");
const viewDiploma = document.querySelector("#viewDiploma");
const downloadDiploma = document.querySelector("#downloadDiploma");
const printDiploma = document.querySelector("#printDiploma");

const pdfUrl = encodeURI(data.source.diplomasPdf);
let activeDiplomaUrl = null;
let parsedDiplomasPromise = null;

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function slugify(value) {
  return normalize(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "diploma";
}

function uniqueAthleteCount() {
  return new Set([
    ...data.rankings.puntos.map((row) => normalize(row.name)),
    ...data.rankings.volantes.map((row) => normalize(row.name)),
  ]).size;
}

function populateSummary() {
  document.querySelector("#totalAthletes").textContent = uniqueAthleteCount();
  document.querySelector("#totalCategories").textContent = data.categories.length;
  document.querySelector("#totalDiplomas").textContent = data.diplomas.length;
}

function populateCategories() {
  categoryFilter.innerHTML = [
    `<option value="Todas">Todas las categorias</option>`,
    ...data.categories.map((category) => `<option value="${category}">${category}</option>`),
  ].join("");
}

function rows() {
  const query = normalize(state.search);
  return data.rankings[state.ranking]
    .filter((row) => state.category === "Todas" || row.category === state.category)
    .filter((row) => {
      if (!query) return true;
      return [row.name, row.team, row.dorsal, row.category].some((value) => normalize(value).includes(query));
    });
}

function bytesToBinary(bytes) {
  const chunkSize = 0x8000;
  let output = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    output += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return output;
}

function binaryToBytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 255;
  }
  return bytes;
}

function parsePdfObjects(bytes) {
  const source = bytesToBinary(bytes);
  const objects = new Map();
  const re = /(\d+)\s+0\s+obj\s*([\s\S]*?)\s*endobj/g;
  let match;

  while ((match = re.exec(source))) {
    objects.set(Number(match[1]), match[2]);
  }

  return objects;
}

function dictPart(body) {
  const streamIndex = body.indexOf("stream");
  return streamIndex >= 0 ? body.slice(0, streamIndex) : body;
}

function refsIn(body) {
  return [...dictPart(body).matchAll(/\b(\d+)\s+0\s+R\b/g)].map((item) => Number(item[1]));
}

function replaceRefs(body, idMap) {
  const replace = (source) => source.replace(/\b(\d+)\s+0\s+R\b/g, (full, id) => {
    const nextId = idMap.get(Number(id));
    return nextId ? `${nextId} 0 R` : full;
  });
  const streamIndex = body.indexOf("stream");

  if (streamIndex < 0) return replace(body);
  return `${replace(body.slice(0, streamIndex))}${body.slice(streamIndex)}`;
}

function pageIdsFromPagesObject(body) {
  const kids = body.match(/\/Kids\s*\[([\s\S]*?)\]/);
  if (!kids) return [];
  return [...kids[1].matchAll(/(\d+)\s+0\s+R/g)].map((item) => Number(item[1]));
}

function collectDependencies(objects, pageId, excludedIds) {
  const required = new Set([pageId]);
  const queue = [pageId];

  while (queue.length) {
    const currentId = queue.shift();
    const body = objects.get(currentId);
    if (!body) continue;

    refsIn(body).forEach((ref) => {
      if (excludedIds.has(ref) || required.has(ref)) return;
      required.add(ref);
      queue.push(ref);
    });
  }

  return [...required];
}

function writePdf(objectsToWrite, rootId) {
  let output = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];

  objectsToWrite.forEach(([id, body]) => {
    offsets[id] = output.length;
    output += `${id} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = output.length;
  const size = objectsToWrite.length + 1;
  output += `xref\n0 ${size}\n`;
  output += "0000000000 65535 f \n";

  for (let id = 1; id < size; id += 1) {
    output += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }

  output += `trailer\n<< /Size ${size} /Root ${rootId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Blob([binaryToBytes(output)], { type: "application/pdf" });
}

async function parseDiplomas() {
  if (!parsedDiplomasPromise) {
    parsedDiplomasPromise = fetch(pdfUrl)
      .then((response) => {
        if (!response.ok) throw new Error("No se pudo cargar el PDF de diplomas.");
        return response.arrayBuffer();
      })
      .then((buffer) => {
        const objects = parsePdfObjects(new Uint8Array(buffer));
        const catalogId = [...objects].find(([, body]) => /\/Type\s*\/Catalog\b/.test(body))?.[0];
        const catalog = objects.get(catalogId);
        const pagesId = Number(catalog?.match(/\/Pages\s+(\d+)\s+0\s+R/)?.[1]);
        const pageIds = pageIdsFromPagesObject(objects.get(pagesId) || "");

        if (!catalogId || !pagesId || !pageIds.length) {
          throw new Error("No se pudo leer la estructura de paginas del PDF.");
        }

        return { objects, catalogId, pagesId, pageIds };
      });
  }

  return parsedDiplomasPromise;
}

function createDiplomaBlob(parsed, pageNumber) {
  const pageId = parsed.pageIds[pageNumber - 1];
  if (!pageId) throw new Error("La pagina del diploma no existe.");

  const dependencies = collectDependencies(
    parsed.objects,
    pageId,
    new Set([parsed.catalogId, parsed.pagesId]),
  );
  const idMap = new Map([[pageId, 3]]);
  let nextId = 4;

  dependencies.forEach((originalId) => {
    if (originalId === pageId) return;
    idMap.set(originalId, nextId);
    nextId += 1;
  });

  const pdfObjects = [
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Count 1 /Kids [3 0 R] >>"],
  ];

  dependencies.forEach((originalId) => {
    let body = parsed.objects.get(originalId);
    if (originalId === pageId) {
      body = body.replace(/\/Parent\s+\d+\s+0\s+R/, "/Parent 2 0 R");
    }
    pdfObjects.push([idMap.get(originalId), replaceRefs(body, idMap)]);
  });

  return writePdf(pdfObjects.sort((a, b) => a[0] - b[0]), 1);
}

async function diplomaFile(row) {
  const pageNumber = Number(row?.diplomaPage);
  if (!pageNumber) return null;

  const parsed = await parseDiplomas();
  const blob = createDiplomaBlob(parsed, pageNumber);
  return {
    href: URL.createObjectURL(blob),
    filename: `${slugify(row.diplomaName || row.name)}-diploma.pdf`,
  };
}

function setDiplomaActions(enabled) {
  [viewDiploma, downloadDiploma].forEach((link) => {
    link.classList.toggle("is-disabled", !enabled);
    link.toggleAttribute("aria-disabled", !enabled);
    link.tabIndex = enabled ? 0 : -1;
  });
  printDiploma.disabled = !enabled;
}

async function selectRow(row) {
  state.selected = row;
  const hasDiploma = Boolean(row?.diplomaPage);

  diplomaName.textContent = row ? row.diplomaName || row.name : "Selecciona un deportista";
  diplomaMeta.textContent = row
    ? `${row.category} | Dorsal ${row.dorsal || "s/d"} | ${hasDiploma ? "Preparando diploma individual..." : "Diploma no vinculado automaticamente"}`
    : "El visor abrira solo el diploma del deportista seleccionado.";
  diplomaFrame.src = "about:blank";
  viewDiploma.removeAttribute("href");
  downloadDiploma.removeAttribute("href");
  setDiplomaActions(false);

  if (!row || !hasDiploma) return;

  try {
    const file = await diplomaFile(row);
    if (state.selected !== row) {
      URL.revokeObjectURL(file.href);
      return;
    }

    if (activeDiplomaUrl) URL.revokeObjectURL(activeDiplomaUrl);
    activeDiplomaUrl = file.href;

    diplomaMeta.textContent = `${row.category} | Dorsal ${row.dorsal || "s/d"} | Diploma individual`;
    viewDiploma.href = file.href;
    downloadDiploma.href = file.href;
    downloadDiploma.download = file.filename;
    diplomaFrame.src = file.href;
    setDiplomaActions(true);
  } catch {
    if (state.selected !== row) return;
    diplomaMeta.textContent = "No se pudo preparar el diploma individual. Intenta abrir la app desde el servidor local.";
  }
}

function render() {
  const currentRows = rows();
  rankingTitle.textContent = state.ranking === "puntos" ? "General puntos" : "Metas volantes";
  resultCount.textContent = `${currentRows.length} resultado${currentRows.length === 1 ? "" : "s"}`;

  if (!currentRows.length) {
    resultsBody.innerHTML = `<tr><td colspan="6" class="empty">No hay resultados con esos filtros.</td></tr>`;
    selectRow(null);
    return;
  }

  resultsBody.innerHTML = currentRows.map((row, index) => `
    <tr>
      <td><span class="rank">${row.position}</span></td>
      <td>${row.dorsal || "s/d"}</td>
      <td>
        <span class="athlete">
          <strong>${row.name}</strong>
          <span>${row.category}</span>
        </span>
      </td>
      <td>${row.team || "Sin equipo"}</td>
      <td><span class="points">${row.points}</span></td>
      <td>
        <button class="button ${index === 0 ? "button--primary" : ""}" type="button" data-index="${index}">
          ${row.diplomaPage ? "Abrir" : "Buscar"}
        </button>
      </td>
    </tr>
  `).join("");

  resultsBody.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      selectRow(currentRows[Number(button.dataset.index)]);
      document.querySelector(".diploma-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  selectRow(currentRows[0]);
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.remove("is-active"));
    tab.classList.add("is-active");
    state.ranking = tab.dataset.ranking;
    render();
  });
});

categoryFilter.addEventListener("change", () => {
  state.category = categoryFilter.value;
  render();
});

searchFilter.addEventListener("input", () => {
  state.search = searchFilter.value;
  render();
});

printDiploma.addEventListener("click", () => {
  if (diplomaFrame.src === "about:blank") return;
  diplomaFrame.contentWindow?.focus();
  diplomaFrame.contentWindow?.print();
});

populateSummary();
populateCategories();
render();
