// Dorama-Flix - doramas en español de DoramasFlix y DoramasYT.
// Catálogo, películas, búsqueda, capítulos y reproducción (latino y subtitulado).
// DoramasFlix se lee por su API pública (GraphQL); DoramasYT, por sus páginas.

const DY = "https://www.doramasyt.com";
const DF = "https://doramasflix.io";
const DF_API = "https://user-api.fluxcedene.net/graphql";
const HOME_ROW = 20;
const MAX_RESULTS = 100;
const CAT_VIEW = 60;  // títulos por tanda de "Ver más"
const CAT_MAX = 100;  // tope de Kino por página

function log(...args) {
  try { kino.log(...args); } catch { /* el registro no debe romper nada */ }
}

// Textos que lee la persona: español por defecto, inglés si kino.lang es "en-US".
function tr(es, en) {
  return (typeof kino !== "undefined" && kino.lang === "en-US") ? en : es;
}

// kino.sleep solo acepta de 0 a 5000 ms: las esperas más largas se hacen por tramos.
async function pause(ms) {
  let left = Math.max(0, Number(ms) || 0);
  while (left > 0) {
    const c = Math.min(left, 5000);
    await kino.sleep(c);
    left -= c;
  }
  return null;
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function stripTags(s) {
  return decodeEntities(String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
}

async function getHtml(url) {
  let r;
  try {
    r = await kino.fetch(url);
  } catch (e) {
    log("fetch falló: " + String((e && e.message) || e).slice(0, 80));
    throw kino.error("unavailable", "fetch falló", {
      userMessage: tr("No se pudo abrir el sitio. Prueba de nuevo en un momento.", "Could not open the site. Try again in a moment."),
    });
  }
  log("fetch status=" + r.status);
  if (!r.ok) {
    const um = { userMessage: tr("El sitio respondió con el error " + r.status + ".", "The site answered with error " + r.status + ".") };
    if (r.status === 404) throw kino.error("not_found", "el sitio respondió 404", um);
    if (r.status === 429) throw kino.error("rate_limited", "el sitio respondió 429", um);
    throw kino.error("unavailable", "el sitio respondió " + r.status, um);
  }
  return r.text();
}

// ---- Secciones: cada una junta varias fuentes y quita los títulos repetidos -------------------

// site: "df" = DoramasFlix (API), "dy" = DoramasYT (páginas).
const SECTIONS = {
  doramas: { parts: [
    { site: "df", kind: "d" },
    { site: "dy", path: "/doramas" },
  ] },
  emision: { parts: [
    { site: "dy", path: "/emision" },
  ] },
  latino: { parts: [
    { site: "dy", path: "/buscar?q=latino" },   // sus series en latino llevan "latino" en el nombre
  ] },
  peliculas: { parts: [
    { site: "df", kind: "m" },
    { site: "dy", path: "/peliculas", movie: true },
  ] },
};

// ---- DoramasYT: tarjetas ---------------------------------------------------------------------

// Cada ficha: <a href=".../dorama/<slug>"> ... <img data-src="..."> ... <h3>Título</h3></a>
function dyCards(html, forceMovie) {
  const byUrl = new Map();
  const re = /<a[^>]+href=["'](https:\/\/www\.doramasyt\.com\/(dorama|pelicula)\/([a-z0-9-]+))["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const e = byUrl.get(m[1]) || { kind: m[2], slug: m[3], title: "", alt: "", poster: undefined };
    const h3 = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(m[4]);
    const text = h3 ? stripTags(h3[1]) : "";
    if (text && !e.title) e.title = text;
    const img = /<img[^>]*>/i.exec(m[4]);
    if (img) {
      const ds = /data-src=["']([^"']+)["']/i.exec(img[0]);
      const sr = /\ssrc=["']([^"']+)["']/i.exec(img[0]);
      if (!e.poster) e.poster = ds ? ds[1] : (sr && !/\/img\//.test(sr[1]) ? sr[1] : undefined);
      const alt = /alt=["']([^"']+)["']/i.exec(img[0]);
      if (alt && !e.alt) e.alt = decodeEntities(alt[1]).replace(/^Ver\s+/i, "").replace(/\s+online.*$/i, "");
    }
    byUrl.set(m[1], e);
  }
  const items = [];
  for (const [url, e] of byUrl) {
    const title = e.title || e.alt;
    if (!title) continue;
    const movie = forceMovie || e.kind === "pelicula";
    items.push({
      id: "dy-" + e.slug.slice(0, 80),
      ref: "dy|" + url,
      title: title.slice(0, 200),
      kind: movie ? "movie" : "series",
      genres: movie ? ["peliculas", "drama"] : ["series", "drama"],
      poster: e.poster,
    });
  }
  return items;
}

// ---- DoramasFlix: API pública (GraphQL) ------------------------------------------------------

async function dfQuery(query, variables) {
  let r;
  try {
    r = await kino.fetch(DF_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json", Origin: DF, Referer: DF + "/",
        "x-brand-host": "doramasflix.io", "x-forwarded-host": "doramasflix.io",
      },
      body: JSON.stringify(variables ? { query, variables } : { query }),
    });
  } catch (e) {
    log("df fetch falló: " + String((e && e.message) || e).slice(0, 80));
    throw kino.error("unavailable", "DoramasFlix no respondió", { userMessage: tr("DoramasFlix no respondió. Prueba de nuevo en un momento.", "DoramasFlix did not answer. Try again in a moment.") });
  }
  log("df api status=" + r.status);
  if (!r.ok) throw kino.error(r.status === 429 ? "rate_limited" : "unavailable", "DoramasFlix error " + r.status, { userMessage: tr("DoramasFlix respondió con el error " + r.status + ".", "DoramasFlix answered with error " + r.status + ".") });
  let j;
  try { j = JSON.parse(await r.text()); } catch (e) { j = null; }
  if (!j || !j.data) {
    log("df api sin datos: " + (j && j.errors && j.errors[0] ? String(j.errors[0].message).slice(0, 100) : "respuesta rara"));
    throw kino.error("unavailable", "DoramasFlix devolvió algo inesperado", { userMessage: tr("DoramasFlix devolvió una respuesta que no entiendo.", "DoramasFlix returned a response I can't read.") });
  }
  if (j.errors && j.errors[0]) log("df api aviso: " + String(j.errors[0].message).slice(0, 100));
  return j.data;
}

function dfPoster(p) {
  if (!p) return undefined;
  p = String(p);
  if (p.charAt(0) === "/") return "https://image.tmdb.org/t/p/w342" + p;
  return /^https?:\/\//i.test(p) ? p : undefined;
}

function dfItem(x, kind) {
  if (!x || !x.slug || !x._id) return null;
  const title = stripTags(x.name_es || x.name);
  if (!title) return null;
  return {
    id: "df-" + String(x.slug).slice(0, 80),
    ref: "df|" + kind + "|" + x.slug + "|" + x._id,
    title: title.slice(0, 200),
    kind: kind === "m" ? "movie" : "series",
    genres: kind === "m" ? ["peliculas", "drama"] : ["series", "drama"],
    poster: dfPoster(x.poster_path || x.poster),
  };
}

function humanSlug(slug) {
  return String(slug || "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Una página de una fuente concreta.
async function partPage(part, n) {
  if (part.site === "df") {
    const field = part.kind === "m" ? "paginationMovie" : "paginationDorama";
    const d = await dfQuery("query C($page:Int,$limit:Int){" + field + "(page:$page,limit:$limit){pageInfo{hasNextPage} items{_id slug name name_es poster_path poster}}}", { page: n, limit: 24 });
    const o = (d && d[field]) || {};
    return { items: (o.items || []).map((x) => dfItem(x, part.kind)).filter(Boolean), hasNext: !!(o.pageInfo && o.pageInfo.hasNextPage) };
  }
  const sep = part.path.indexOf("?") >= 0 ? "&" : "?";
  const html = await getHtml(DY + part.path + (n > 1 ? sep + "p=" + n : ""));
  return { items: dyCards(html, !!part.movie), hasNext: html.indexOf("p=" + (n + 1)) !== -1 };
}

// Para detectar el mismo título en fuentes distintas: sin acentos, sin "latino", solo letras y números.
function normTitle(t) {
  let x = String(t || "").toLowerCase();
  if (typeof x.normalize === "function") x = x.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return x.replace(/\blatino\b/g, "").replace(/[^a-z0-9]+/g, "");
}

// Junta los títulos repetidos (mismo nombre, fuentes distintas) en UNA sola tarjeta.
// La tarjeta conserva todas las direcciones ("mx|a||b"); al abrirla, episodes() elige la que tenga más capítulos.
const SRC_PRIO = { df: -1, dy: 2 };

// Títulos con evidencia de estar en latino (el nombre o la dirección de DoramasYT lo dicen).
// Se guardan por id para poner primero los latinos sin agregar campos raros a los ítems.
const LATINO_IDS = new Set();
const looksLatino = (x) => /latino/i.test(String((x && x.title) || "") + " " + String((x && x.ref) || ""));
function latinoFirst(items) {
  const a = [];
  const b = [];
  for (const x of items) (LATINO_IDS.has(x.id) ? a : b).push(x);
  return a.concat(b);
}

function mergeDupes(items) {
  const groups = new Map();
  const order = [];
  for (const x of items) {
    const k = normTitle(x.title) || x.id;
    let g = groups.get(k);
    if (!g) { g = []; groups.set(k, g); order.push(k); }
    g.push(x);
  }
  return order.map((k) => {
    const g = groups.get(k);
    const lat = g.some(looksLatino);
    if (g.length === 1) { if (lat) LATINO_IDS.add(g[0].id); return g[0]; }
    g.sort((a, b) => (SRC_PRIO[a.ref.slice(0, 2)] || 0) - (SRC_PRIO[b.ref.slice(0, 2)] || 0));
    const first = Object.assign({}, g[0]);
    if (!first.poster) { const p = g.find((y) => y.poster); if (p) first.poster = p.poster; }
    const refs = [];
    for (const y of g) if (refs.indexOf(y.ref) < 0) refs.push(y.ref);
    if (refs.length > 1) first.ref = "mx|" + refs.join("||");
    if (lat) LATINO_IDS.add(first.id);
    return first;
  });
}

// Una página de una sección: pide todas sus fuentes a la vez, intercala sus títulos y quita los repetidos.
async function sectionPage(ref, n) {
  const sec = SECTIONS[ref];
  const res = await Promise.allSettled(sec.parts.map((p) => partPage(p, n)));
  const ok = res.filter((r) => r.status === "fulfilled");
  if (!ok.length) throw res[0].reason;
  const lists = ok.map((r) => r.value.items);
  const mixed = [];
  const longest = Math.max.apply(null, lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const l of lists) if (l[i]) mixed.push(l[i]);
  }
  // Prioridad a latino: dentro de cada página, primero los títulos que están en latino.
  return { items: latinoFirst(mergeDupes(mixed)), hasNext: ok.some((r) => r.value.hasNext) };
}

export async function home() {
  await null; // por si algo de abajo lanza: nunca antes del primer await
  const defs = [
    { id: "row-doramas", ref: "doramas", title: tr("Doramas", "Dramas") },
    { id: "row-emision", ref: "emision", title: tr("En emisión", "Airing") },
    { id: "row-latino", ref: "latino", title: tr("En Latino", "In Latin Spanish") },
    { id: "row-peliculas", ref: "peliculas", title: tr("Películas", "Movies") },
  ];
  const res = await Promise.allSettled(defs.map((d) => sectionPage(d.ref, 1)));
  const rows = [];
  res.forEach((r, i) => {
    if (r.status !== "fulfilled") { log("home: falló " + defs[i].id); return; }
    const items = r.value.items.slice(0, HOME_ROW);
    if (items.length) rows.push({ id: defs[i].id, title: defs[i].title, ref: defs[i].ref, items });
  });
  log("home filas=" + rows.length);
  if (!rows.length) throw kino.error("unavailable", "inicio sin resultados");
  return rows;
}

// "Ver más" y catálogos: el cursor es el número de página; cada tanda junta varias páginas.
export async function browse(ref, cursor) {
  await null;
  const r = String(ref || "");
  if (!SECTIONS[r]) throw kino.error("not_found", "catálogo desconocido");
  const n = Math.max(1, parseInt(cursor, 10) || 1);
  const items = [];
  const seen = new Set();
  let p = n;
  let last = n - 1;
  let hasNext = true;
  let rounds = 0;
  while (hasNext && items.length < CAT_VIEW && rounds < 3) {
    rounds++;
    const batch = await Promise.allSettled([0, 1, 2].map((k) => sectionPage(r, p + k)));
    let stop = false;
    for (let k = 0; k < batch.length; k++) {
      const res = batch[k];
      if (res.status !== "fulfilled") {
        if (last < n) throw res.reason; // ni la primera página cargó: error de verdad
        stop = true;
        break;
      }
      const fresh = res.value.items.filter((x) => !seen.has(x.id));
      if (items.length && items.length + fresh.length > CAT_MAX) { stop = true; break; }
      for (const x of fresh) { seen.add(x.id); items.push(x); }
      last = p + k;
      hasNext = res.value.hasNext;
      if (!hasNext || items.length >= CAT_VIEW) { stop = true; break; }
    }
    if (stop) break;
    p += 3;
  }
  const page = { items: items.slice(0, CAT_MAX) };
  if (hasNext && items.length) page.next = String(last + 1);
  return page;
}

// Mosaicos de la sección Categorías; cada uno abre browse(ref, null).
export async function categories() {
  await null;
  const defs = [
    { id: "doramas", title: tr("Doramas", "Dramas") },
    { id: "emision", title: tr("En emisión", "Airing") },
    { id: "latino", title: tr("En Latino", "In Latin Spanish") },
    { id: "peliculas", title: tr("Películas", "Movies") },
  ];
  const first = await Promise.allSettled(defs.map((d) => sectionPage(d.id, 1)));
  return defs.map((d, i) => {
    const r = first[i];
    const art = r.status === "fulfilled" && r.value.items[0] ? r.value.items[0].poster : undefined;
    return art ? { id: d.id, title: d.title, ref: d.id, art } : { id: d.id, title: d.title, ref: d.id };
  });
}

export async function search(query) {
  await null;
  const q = stripTags(query && query.q).slice(0, 100);
  if (!q) return [];
  let qa = q;
  if (typeof q.normalize === "function") qa = q.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  qa = qa.replace(/[¡!¿?:,.]/g, " ").replace(/\s+/g, " ").trim() || q;
  const dfSearch = async () => {
    const d = await dfQuery("query S($input:String,$limit:Int){searchDorama(input:$input,limit:$limit){_id slug name name_es poster_path poster} searchMovie(input:$input,limit:$limit){_id slug name name_es poster_path poster}}", { input: qa, limit: 30 });
    return ((d && d.searchDorama) || []).map((x) => dfItem(x, "d")).concat(((d && d.searchMovie) || []).map((x) => dfItem(x, "m"))).filter(Boolean);
  };
  // DoramasYT: la primera página y, si hay, la segunda.
  const dySearch = async () => {
    const base = DY + "/buscar?q=" + encodeURIComponent(qa);
    const h1 = await getHtml(base);
    let found = dyCards(h1, false);
    if (h1.indexOf("p=2") !== -1) {
      try { found = found.concat(dyCards(await getHtml(base + "&p=2"), false)); } catch (e) { log("búsqueda: la página 2 falló"); }
    }
    return found;
  };
  // Se busca en las dos a la vez; en la lista salen primero los de DoramasFlix y después los de DoramasYT.
  const [f, y] = await Promise.allSettled([dfSearch(), dySearch()]);
  if (f.status === "rejected" && y.status === "rejected") throw f.reason;
  if (f.status !== "fulfilled") log("búsqueda: DoramasFlix falló");
  if (y.status !== "fulfilled") log("búsqueda: DoramasYT falló");
  const all = (f.status === "fulfilled" ? f.value : []).concat(y.status === "fulfilled" ? y.value : []);
  log("búsqueda: " + all.length + " resultados");
  // Primero lo que viene de DoramasFlix (incluidas las tarjetas combinadas) y, dentro de cada grupo,
  // los títulos en latino por delante.
  const merged = mergeDupes(all);
  const fromDf = (x) => /^(df\||mx\|df\|)/.test(String(x.ref));
  return latinoFirst(merged.filter(fromDf)).concat(latinoFirst(merged.filter((x) => !fromDf(x)))).slice(0, MAX_RESULTS);
}

// ---- Episodios --------------------------------------------------------------------------------

async function dyEpisodes(url) {
  const html = await getHtml(url);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  const og = /property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html);
  const title = h1 ? stripTags(h1[1]).replace(/^Ver\s+/i, "").replace(/\s+(online|en español).*$/i, "") : url;
  const eps = new Map();
  const re = /href=["'](https:\/\/www\.doramasyt\.com\/ver\/[a-z0-9-]+-episodio-(\d+))["']/gi;
  let m;
  while ((m = re.exec(html))) {
    if (eps.has(m[1])) continue;
    eps.set(m[1], { season: 1, number: Number(m[2]), ref: "dy|" + m[1], title: tr("Episodio ", "Episode ") + m[2] });
  }
  log("dy episodes: " + eps.size);
  if (!eps.size) throw kino.error("not_found", "no se encontró la lista de episodios", {
    userMessage: tr("No se encontró la lista de capítulos de este título.", "No episode list found for this title."),
  });
  const list = Array.from(eps.values()).sort((a, b) => a.number - b.number);
  return { series: { title, poster: og ? og[1] : undefined }, episodes: list };
}

async function dfEpisodes(spec) {
  const parts = spec.split("|");
  const kind = parts[0], slug = parts[1], id = parts[2];
  const title = humanSlug(slug);
  if (kind === "m") return { series: { title }, episodes: [{ season: 1, number: 1, ref: "df|m|" + slug + "|" + id, title }] };
  const season = async (n) => {
    const out = [];
    for (let page = 1; page <= 3; page++) {
      const d = await dfQuery('{paginationEpisode(filter:{serie_id:' + JSON.stringify(id) + ',season_number:' + n + '},page:' + page + ',limit:100){items{_id slug episode_number name name_es still_path backdrop} pageInfo{hasNextPage}}}');
      const o = d && d.paginationEpisode;
      if (!o || !o.items) break;
      for (const e of o.items) out.push({ n, e });
      if (!(o.pageInfo && o.pageInfo.hasNextPage)) break;
    }
    return out;
  };
  const res = await Promise.allSettled([1, 2, 3, 4, 5, 6].map(season));
  const list = [];
  for (const r of res) {
    if (r.status !== "fulfilled") continue;
    for (const { n, e } of r.value) {
      if (!e || !e._id) continue;
      const num = Number(e.episode_number) || list.length + 1;
      list.push({ season: n, number: num, ref: "df|e|" + e._id, title: stripTags(e.name_es || e.name) || tr("Episodio ", "Episode ") + num, poster: dfPoster(e.still_path || e.backdrop) });
    }
  }
  log("df episodes: " + list.length);
  if (!list.length) throw kino.error("not_found", "sin capítulos en DoramasFlix", { userMessage: tr("No se encontró la lista de capítulos de este título.", "No episode list found for this title.") });
  list.sort((a, b) => (a.season - b.season) || (a.number - b.number));
  return { series: { title }, episodes: list };
}

export async function episodes(ref) {
  await null;
  const raw = String(ref || "");
  // Tarjeta combinada: se piden las listas de todas las fuentes a la vez y gana la que tenga más capítulos.
  if (raw.startsWith("mx|")) {
    const refs = raw.slice(3).split("||").filter(Boolean).slice(0, 4);
    const res = await Promise.allSettled(refs.map((r) => episodes(r)));
    let best = null;
    let bestI = -1;
    res.forEach((r, i) => {
      if (r.status !== "fulfilled" || !r.value || !r.value.episodes) { log("episodes: falló " + refs[i].slice(0, 2)); return; }
      log("episodes: " + refs[i].slice(0, 2) + "=" + r.value.episodes.length);
      if (!best || r.value.episodes.length > best.episodes.length) { best = r.value; bestI = i; }
    });
    if (!best) throw res[0].reason || kino.error("not_found", "sin lista de episodios");
    // Cada capítulo recuerda los mismos capítulos (misma temporada y número) de las otras fuentes,
    // para pasar a otra si la primera no entrega el video.
    const byKey = res.map((r) => {
      const m = new Map();
      if (r.status === "fulfilled" && r.value && r.value.episodes) for (const e of r.value.episodes) m.set(e.season + "x" + e.number, e.ref);
      return m;
    });
    const eps = best.episodes.map((e) => {
      const alts = [e.ref];
      byKey.forEach((m, i) => { if (i !== bestI) { const o = m.get(e.season + "x" + e.number); if (o && alts.indexOf(o) < 0) alts.push(o); } });
      alts.sort((x, y) => (SRC_PRIO[x.slice(0, 2)] || 0) - (SRC_PRIO[y.slice(0, 2)] || 0));
      return alts.length > 1 ? Object.assign({}, e, { ref: "mx|" + alts.join("||") }) : e;
    });
    return Object.assign({}, best, { episodes: eps });
  }
  if (raw.startsWith("df|")) return dfEpisodes(raw.slice(3));
  if (raw.startsWith("dy|")) return dyEpisodes(raw.slice(3));
  throw kino.error("not_found", "referencia desconocida");
}

// ---- Reproducción: utilidades -----------------------------------------------------------------

function hostOf(u) {
  const m = /^https?:\/\/([^\/?#]+)/i.exec(String(u || ""));
  return m ? m[1] : "";
}

// Forma de la ruta sin el código: /e/xxxx -> "/e/". Sirve para el registro sin filtrar enlaces.
function pathShape(u) {
  const m = /^https?:\/\/[^\/?#]+(\/[^?#]*)?/i.exec(String(u || ""));
  const p = m && m[1] ? m[1] : "";
  return p.replace(/[A-Za-z0-9_-]{8,}/g, "~").slice(0, 40);
}

function absUrl(u) {
  let x = String(u || "").trim();
  if (x.startsWith("//")) x = "https:" + x;
  return /^https:\/\//i.test(x) ? x : "";
}

// Las cabeceras que el reproductor manda con el video: la página del reproductor como Referer
// y su origen como Origin (algunos servidores, como Mixdrop, responden 403 si falta alguno).
function playHeaders(embedUrl) {
  const m = /^(https?:\/\/[^\/?#]+)/i.exec(String(embedUrl || ""));
  const h = { Referer: embedUrl };
  if (m) h.Origin = m[1];
  return h;
}

// Servidores que por lo visto casi nunca se pueden abrir desde aquí:
// Byse se queda en "Loading...", DoodStream pide un captcha (no se salta) y Abyss es muy cerrado.
const DEAD_HOST = /byse|dood|do7go|d0000d|d000d|dsvplay|abyss/i;

// Orden de preferencia de los servidores (los que más a menudo entregan el video).
const SERVER_RANK = ["voe", "streamtape", "mp4upload", "lulu", "savefiles", "mxdrop", "uqload", "ok.ru", "filemoon", "mega"];

// -- Lectura de reproductores embebidos ---------------------------------------------------------
// Muchos reproductores esconden el video: dentro de un script "empaquetado" (eval(function(p,a,c,k,e,d)...)
// o en un texto en base64 (atob). Aquí se desarman, sin ejecutar nada, para buscar el .m3u8 / .mp4.

const MEDIA_RE = /["'`]((?:https?:)?\/\/[^"'`\s<>\\]+?\.(?:m3u8|mp4)(?:\?[^"'`\s<>\\]*)?)["'`]/i;

// Videos de prueba que traen los reproductores y sus librerías (Big Buck Bunny y compañía).
const DEMO_MEDIA = /big[_-]?buck[_-]?bunny|\bbbb[_-]|sintel|elephants?[_-]?dream|tears[_-]?of[_-]?steel|gtv-videos-bucket|commondatastorage|test-?streams|test-videos\.co\.uk|bitdash|bitmovin|mux\.dev|zencdn|oceans\.mp4|flowplayer\.com|jwplatform|\/samples?\/|(?:googleapis|gstatic|jsdelivr|cdnjs|unpkg)\./i;
const isDemo = (u) => DEMO_MEDIA.test(String(u || ""));

function normText(s) {
  return String(s || "").replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/&amp;/g, "&");
}

// Desarma un script empaquetado con el método clásico "p,a,c,k,e,d".
function unpackPacked(src) {
  const re = /\}\s*\(\s*(['"])((?:\\[\s\S]|(?!\1)[^\\])*)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])((?:\\[\s\S]|(?!\5)[^\\])*)\5\s*\.split\(\s*['"]\|['"]\s*\)/;
  const m = re.exec(src);
  if (!m) return null;
  const payload = m[2].replace(/\\(['"\\])/g, "$1").replace(/\\n/g, "\n");
  const radix = Number(m[3]);
  let count = Number(m[4]);
  if (!(radix >= 2 && radix <= 62) || !(count > 0 && count < 100000)) return null;
  const dict = m[6].split("|");
  const enc = (c) => (c < radix ? "" : enc(Math.floor(c / radix))) + ((c = c % radix) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
  const map = {};
  while (count--) map[enc(count)] = dict[count] || enc(count);
  return payload.replace(/\b\w+\b/g, (w) => (map[w] != null ? map[w] : w));
}

function unpackAll(html) {
  const out = [];
  let i = 0;
  while (out.length < 4) {
    const k = html.indexOf("eval(function(p,a,c,k,e", i);
    if (k < 0) break;
    const u = unpackPacked(html.slice(k, k + 80000));
    if (u) out.push(u);
    i = k + 20;
  }
  return out;
}

function base64Texts(html) {
  const out = [];
  const re = /atob\(\s*["']([A-Za-z0-9+\/=_-]{16,})["']\s*\)/g;
  let m;
  while ((m = re.exec(html)) && out.length < 6) {
    try { out.push(atob(m[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch (e) { /* no era base64 */ }
  }
  return out;
}

// VOE esconde sus datos en un <script type="application/json"> con un texto en varias capas
// (ROT13, símbolos de relleno, base64, desplazamiento de letras, reverso y base64 otra vez).
// OJO: este método cambia con el tiempo y no se ha comprobado contra el sitio real; si ya no coincide,
// simplemente no encuentra nada y el plugin sigue con los demás servidores.
function rot13(s) {
  return String(s).replace(/[A-Za-z]/g, (c) => {
    const b = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
  });
}
function voeDecode(enc) {
  try {
    let s = rot13(enc);
    for (const p of ["@$", "^^", "~@", "%?", "*~", "!!", "#&"]) s = s.split(p).join("");
    s = atob(s);
    let t = "";
    for (let i = 0; i < s.length; i++) t += String.fromCharCode(s.charCodeAt(i) - 3);
    t = t.split("").reverse().join("");
    return JSON.parse(atob(t));
  } catch (e) { return null; }
}
function jsonScripts(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 6) out.push(m[1].trim());
  return out;
}
function voeMedia(html) {
  for (const body of jsonScripts(html)) {
    let v;
    try { v = JSON.parse(body); } catch (e) { continue; }
    const enc = Array.isArray(v) ? v[0] : v;
    if (typeof enc !== "string" || enc.length < 40) continue;
    const j = voeDecode(enc);
    if (!j || typeof j !== "object") continue;
    for (const k of ["source", "direct_access_url", "file", "hls"]) {
      const u = absUrl(j[k]);
      if (u && !isDemo(u)) return u;
    }
  }
  return "";
}

// OK.ru: la página trae un data-options con un JSON que lista el video en varias calidades.
const OK_ORDER = ["mobile", "lowest", "low", "sd", "hd", "full", "quad", "ultra"];
function okMedia(html) {
  const attrs = /data-options="([^"]*)"/.exec(html) || /data-options='([^']*)'/.exec(html);
  if (!attrs) return "";
  let md = null;
  try {
    const opts = JSON.parse(decodeEntities(attrs[1]));
    md = opts && opts.flashvars ? opts.flashvars.metadata : null;
    if (typeof md === "string") md = JSON.parse(md);
  } catch (e) { return ""; }
  if (!md || typeof md !== "object") return "";
  const vids = (Array.isArray(md.videos) ? md.videos : [])
    .filter((v) => v && typeof v.url === "string" && /^https:\/\//.test(v.url) && OK_ORDER.indexOf(v.name) >= 0)
    .sort((a, b) => OK_ORDER.indexOf(b.name) - OK_ORDER.indexOf(a.name)); // la mejor primero
  const limit = OK_ORDER.indexOf("full");
  const best = vids.find((v) => OK_ORDER.indexOf(v.name) <= limit) || vids[0];
  if (best) return best.url;
  const hls = md.hlsManifestUrl || md.ondemandHls || md.hlsMasterPlaylistUrl;
  return typeof hls === "string" && /^https:\/\//.test(hls) ? hls : "";
}

function findMedia(text) {
  const re = new RegExp(MEDIA_RE.source, "gi");
  const t = normText(text);
  let m;
  while ((m = re.exec(t))) {
    const u = absUrl(m[1]);
    if (u && !isDemo(u)) return u;
    if (u) log("video de muestra descartado: " + hostOf(u) + pathShape(u));
  }
  return "";
}

// Igual, pero sin exigir comillas: el texto que sale de un base64 suele ser el enlace "pelado".
function findMediaLoose(text) {
  const re = /((?:https?:)?\/\/[^\s"'`<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'`<>\\]*)?)/gi;
  const t = normText(text);
  let m;
  while ((m = re.exec(t))) {
    const u = absUrl(m[1]);
    if (u && !isDemo(u)) return u;
    if (u) log("video de muestra descartado: " + hostOf(u) + pathShape(u));
  }
  return "";
}

// Busca el video escrito en la página, en sus scripts empaquetados o en sus textos base64.
function deepMedia(html) {
  let u = findMedia(html);
  if (u) return u;
  for (const t of unpackAll(html)) { u = findMedia(t); if (u) return u; }
  for (const t of base64Texts(html)) { u = findMediaLoose(t); if (u) return u; }
  u = voeMedia(html);
  if (u) return u;
  return "";
}

const SKIP_HOST = /(google|gstatic|facebook|doubleclick|googletagmanager|cloudflare|jsdelivr|cdnjs|jquery|bootstrap|fontawesome|histats|yandex)/i;

// Enlaces a otras páginas de reproductor que esta página abre o inserta (iframes y textos de script).
function embedLinks(html, base) {
  const texts = [html].concat(unpackAll(html), base64Texts(html));
  const out = [];
  const add = (u) => {
    const a = absUrl(u);
    if (!a || a === base || out.indexOf(a) >= 0) return;
    if (SKIP_HOST.test(hostOf(a))) return;
    if (/\.(?:js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)(\?|$)/i.test(a)) return;
    out.push(a);
  };
  const decoded = base64Texts(html);
  for (const raw of texts) {
    const t = normText(raw);
    const fr = /<iframe[^>]*src=["']([^"']+)["']/gi;
    let f;
    while ((f = fr.exec(t))) add(f[1]);
    const ur = /["'`]((?:https?:)?\/\/[^"'`\s<>\\]+)["'`]/g;
    let u;
    while ((u = ur.exec(t))) {
      if (/\/(?:e|embed|v|f|play|player|stream|d)\/[A-Za-z0-9_-]{6,}/i.test(u[1])) add(u[1]);
    }
  }
  for (const raw of decoded) {
    const bare = /(?:https?:)?\/\/[^\s"'`<>\\]+/g;
    let b;
    while ((b = bare.exec(normText(raw)))) add(b[0]);
  }
  return out.slice(0, 4);
}

function redact(s) {
  return String(s || "")
    .replace(/https?:\/\/[^\s"'<>]+/g, (u) => hostOf(u) + pathShape(u))
    .replace(/[A-Za-z0-9+\/=_-]{16,}/g, "~")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

// Radiografía de una página de reproductor para el registro (sin códigos ni enlaces completos).
function diag(html, depth, found) {
  const title = /<title[^>]*>([^<]*)/i.exec(html);
  const scripts = [];
  const sre = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let s;
  while ((s = sre.exec(html))) scripts.push({ attrs: s[1], body: s[2] });
  const inline = scripts.filter((x) => x.body.trim()).sort((a, b) => b.body.length - a.body.length);
  const links = embedLinks(html, "").map((u) => hostOf(u) + pathShape(u));
  const js = jsonScripts(html).map((b) => b.length);
  log("embed[" + depth + "] bytes=" + html.length + " titulo=" + (title ? title[1].trim().slice(0, 40) : "-") +
    " video=" + (found ? "si" : "no") + " packed=" + unpackAll(html).length + " atob=" + base64Texts(html).length +
    " json=" + (js.length ? js.join("/") : "0") + " iframes=" + (html.split("<iframe").length - 1) +
    " scriptsInline=" + inline.length + " enlaces=" + links.join(","));
  if (!found && inline.length) log("embed[" + depth + "] script mayor: " + redact(inline[0].body));
}

// Lee la página de un reproductor y busca el video; si no está, sigue los reproductores que esa
// página abre (hasta 2 niveles).
async function embedFromHtml(embedUrl, depth, referer) {
  const d = depth || 0;
  const r = await kino.fetch(embedUrl, { headers: { Referer: referer || DF + "/" } });
  log("embed[" + d + "] " + hostOf(embedUrl) + pathShape(embedUrl) + " status=" + r.status);
  if (!r.ok) return null;
  let html = await r.text();

  // OK.ru: el video sale de su data-options, no de un .mp4 escrito en la página.
  if (/(^|\.)ok\.ru$/i.test(hostOf(embedUrl))) {
    const ok = okMedia(html);
    log("embed[" + d + "] ok.ru video=" + (ok ? "si" : "no"));
    if (ok) return { url: ok, mime: /\.m3u8/i.test(ok) ? "application/x-mpegurl" : "video/mp4", headers: { Referer: "https://ok.ru/", Origin: "https://ok.ru" } };
    return null;
  }

  let u = deepMedia(html);
  // Una página diminuta, sin video ni enlaces, suele ser una pantalla de comprobación del servidor:
  // con la cookie que acaba de dejar, el segundo intento trae la página real. Un solo reintento.
  if (!u && d >= 1 && html.length < 3000 && !/byse/i.test(hostOf(embedUrl)) && !embedLinks(html, embedUrl).length) {
    log("embed[" + d + "] página diminuta (" + html.length + " bytes): reintento");
    if (typeof kino.sleep === "function") await kino.sleep(900);
    const r2 = await kino.fetch(embedUrl, { headers: { Referer: referer || DF + "/" } });
    if (r2.ok) {
      const h2 = await r2.text();
      if (h2.length > html.length) { html = h2; u = deepMedia(html); }
    }
  }
  diag(html, d, !!u);
  if (u) {
    log("embed[" + d + "] video elegido: " + hostOf(u) + pathShape(u));
    return { url: u, mime: /\.m3u8/i.test(u) ? "application/x-mpegurl" : "video/mp4", headers: playHeaders(embedUrl) };
  }
  if (d >= 2) return null;
  const links = embedLinks(html, embedUrl).filter((l) => !/byse/i.test(hostOf(l))).slice(0, d === 0 ? 3 : 2);
  for (const l of links) {
    try {
      const got = await embedFromHtml(l, d + 1, embedUrl);
      if (got) return got;
    } catch (e) {
      log("embed[" + (d + 1) + "] falló: " + String((e && e.message) || e).slice(0, 60));
    }
  }
  return null;
}

// Devuelve el primer resultado que llegue (no el último): { v, i } o null si ninguno entrega nada.
function firstSuccess(tasks) {
  return new Promise((resolveAll) => {
    let pending = tasks.length;
    if (!pending) { resolveAll(null); return; }
    tasks.forEach((t, i) => {
      Promise.resolve(t).then((v) => { if (v) resolveAll({ v, i }); }, () => {}).then(() => {
        pending--;
        if (pending === 0) resolveAll(null);
      });
    });
  });
}

const NO_VIDEO = () => kino.error("unavailable", "ningún servidor entregó el video", {
  userMessage: tr(
    "Ningún servidor de este capítulo se pudo abrir desde aquí. Prueba otro capítulo o título.",
    "No server for this episode could be opened from here. Try another episode or title."
  ),
});

// ---- Reproducción: DoramasYT -------------------------------------------------------------------

async function dyResolve(url) {
  // Una película de DoramasYT es una ficha /dorama/ con un solo capítulo: se busca ese capítulo.
  if (/\/dorama\//.test(url)) {
    const e = await dyEpisodes(url);
    if (!e.episodes.length) throw NO_VIDEO();
    url = e.episodes[0].ref.slice(3);
  }
  const html = await getHtml(url);
  const btns = [];
  const re = /<button[^>]*data-player=["']([^"']+)["'][^>]*>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = re.exec(html))) btns.push({ token: m[1], name: stripTags(m[2]).toLowerCase() });
  log("dy resolve: servidores=" + btns.map((b) => b.name).join(","));
  if (!btns.length) throw kino.error("unavailable", "sin servidores", {
    userMessage: tr("Este capítulo no trae servidores disponibles.", "This episode has no servers available."),
  });
  const rank = (b) => { const i = SERVER_RANK.indexOf(b.name); return (DEAD_HOST.test(b.name) ? 100 : 0) + (i < 0 ? 50 : i); };
  const cands = btns.filter((b) => b.name !== "mega").sort((a, b) => rank(a) - rank(b)).slice(0, 4);
  const lat = /-latino-/i.test(url);
  const label = (b) => (lat ? "Latino" : tr("Subtitulado", "Subbed")) + " · " + b.name;
  // El reproductor de la página es un iframe a /reproductor?video=<código>&player=<nombre>.
  const tasks = cands.map((b) => {
    const pu = DY + "/reproductor?video=" + b.token + "&player=" + encodeURIComponent(b.name) + "&token=";
    return embedFromHtml(pu, 0, url).then((v) => (v ? Object.assign(v, { label: label(b) }) : null));
  });
  const first = await firstSuccess(tasks);
  if (first) return first.v;
  throw NO_VIDEO();
}

// ---- Reproducción: DoramasFlix -----------------------------------------------------------------

// Los enlaces "embedshortener" llevan el enlace real escondido en base64 (sin ejecutar nada).
function dfUnwrap(u) {
  try {
    if (hostOf(u).indexOf("embedshortener") < 0) return u;
    const tok = String(u).split("/").pop().split(".")[1];
    const j = JSON.parse(atob(tok.replace(/-/g, "+").replace(/_/g, "/")));
    const t = atob(String(j.link).replace(/-/g, "+").replace(/_/g, "/"));
    return /^https?:\/\//i.test(t) ? t : u;
  } catch (e) { return u; }
}

// DoramasFlix guarda los idiomas como números (lang). Los nombres vienen en los datos de su página.
let dfLangs = null;
async function dfLangNames() {
  if (dfLangs) return dfLangs;
  const map = {};
  try {
    const r = await kino.fetch(DF + "/");
    const html = r.ok ? String(await r.text()).replace(/\\"/g, '"') : "";
    const i = html.indexOf('"langs":[');
    if (i >= 0) {
      let d = 0, j = i + 8, end = -1;
      for (; j < html.length; j++) { const c = html.charAt(j); if (c === "[") d++; else if (c === "]") { d--; if (!d) { end = j; break; } } }
      if (end > 0) for (const x of JSON.parse(html.slice(i + 8, end + 1))) if (x && x.code_flix != null) map[String(x.code_flix)] = String(x.name || "");
    }
  } catch (e) { log("df idiomas: no se pudieron leer"); }
  log("df idiomas: " + JSON.stringify(map).slice(0, 160));
  dfLangs = map;
  return map;
}

async function dfResolve(spec) {
  const parts = spec.split("|");
  const isMovie = parts[0] === "m";
  const id = isMovie ? parts[2] : parts[1];
  const field = isMovie ? "getMovieLinks" : "getEpisodeLinks";
  const d = await dfQuery("{" + field + "(id:" + JSON.stringify(id) + "){links_online{link server lang}}}");
  const raw = (d && d[field] && d[field].links_online) || [];
  // Orden de prueba: los servidores que sí suelen abrir primero; los "muertos" (Byse, DoodStream, Abyss) al final.
  const rank = (u) => { const h = hostOf(u); const i = SERVER_RANK.findIndex((n) => h.indexOf(n) >= 0); return (DEAD_HOST.test(h) ? 100 : 0) + (i < 0 ? 50 : i); };
  const names = await dfLangNames();
  const all = raw.map((x) => ({ u: dfUnwrap(String((x && x.link) || "")), lang: String((x && x.lang) == null ? "" : x.lang) }))
    .filter((x) => /^https?:\/\//i.test(x.u) && hostOf(x.u).indexOf("primeload") < 0);
  // Por lo visto en los registros: el idioma 38 es el latino y el 13109 el subtitulado.
  for (const x of all) { x.name = names[x.lang] || (x.lang === "38" ? "Latino" : x.lang === "13109" ? tr("Subtitulado", "Subbed") : ""); x.latino = /lat/i.test(x.name); }
  all.sort((a, b) => ((b.latino ? 1 : 0) - (a.latino ? 1 : 0)) || (rank(a.u) - rank(b.u)));
  log("df resolve: enlaces=" + all.map((x) => hostOf(x.u) + ":lang" + x.lang + (x.name ? "(" + x.name + ")" : "")).join(","));
  const links = all.map((x) => x.u);
  const langOf = {};
  for (const x of all) langOf[x.u] = x.name;
  const one = async (u) => {
    if (/\.(?:m3u8|mp4)(\?|$)/i.test(u) && !isDemo(u)) return { url: u, mime: /\.m3u8/i.test(u) ? "application/x-mpegurl" : "video/mp4", headers: { Referer: DF + "/" }, label: "DoramasFlix" };
    const v = await embedFromHtml(u, 0, DF + "/");
    return v ? Object.assign(v, { label: (langOf[u] ? langOf[u] + " · " : "DoramasFlix · ") + hostOf(u) }) : null;
  };
  // Primero solo los servidores en latino; si ninguno abre, se prueban los demás.
  const lat = all.filter((x) => x.latino).map((x) => x.u);
  const otros = all.filter((x) => !x.latino).map((x) => x.u);
  if (lat.length) {
    const fl = await firstSuccess(lat.slice(0, 3).map(one));
    if (fl) return fl.v;
    log("df resolve: el latino no abrió, se prueba el otro idioma");
  }
  const first = await firstSuccess((lat.length ? otros : links).slice(0, 4).map(one));
  if (first) return first.v;
  throw NO_VIDEO();
}

// ---- Reproducción: capítulo con varias fuentes -------------------------------------------------

// Se prueba la primera fuente y, si falla o tarda, se pasa a la siguiente.
// Prioridad a latino: si una fuente solo entrega subtitulado, se prueban las demás por si alguna lo tiene
// en latino; si ninguna, se queda con el subtitulado.
async function resolveAny(refs) {
  const t0 = Date.now();
  let lastErr = null;
  let fallback = null;
  const canRace = typeof kino.sleep === "function";
  const isSub = (s) => /^(Subtitulado|Subbed)/.test(String((s && s.label) || ""));
  for (let i = 0; i < refs.length; i++) {
    const left = 19000 - (Date.now() - t0);
    if (left < 3500) break;
    const cap = i === refs.length - 1 ? left : Math.min(left, 9000);
    log("resolve: fuente " + (i + 1) + "/" + refs.length + " (" + refs[i].slice(0, 2) + ")");
    const attempt = resolve(refs[i]).catch((e) => { lastErr = e; log("resolve: " + refs[i].slice(0, 2) + " falló"); return null; });
    // OJO: kino.sleep solo acepta hasta 5000 ms; pause() hace las esperas largas por tramos.
    const got = canRace ? await Promise.race([attempt, pause(cap)]) : await attempt;
    if (got && !isSub(got)) return got;
    if (got && !fallback) { fallback = got; log("resolve: solo subtitulado en " + refs[i].slice(0, 2) + ", se busca latino en las otras fuentes"); }
  }
  if (fallback) return fallback;
  throw lastErr || NO_VIDEO();
}

export async function resolve(ref) {
  await null;
  const raw = String(ref || "");
  if (raw.startsWith("mx|")) return resolveAny(raw.slice(3).split("||").filter(Boolean).slice(0, 3));
  if (raw.startsWith("df|")) return dfResolve(raw.slice(3));
  if (raw.startsWith("dy|")) return dyResolve(raw.slice(3));
  throw kino.error("not_found", "referencia desconocida");
}
