const $ = (selector) => document.querySelector(selector);

let csrfToken = "";
let authenticated = false;
let episodes = [];
let toastTimer;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (csrfToken && options.method && options.method !== "GET") {
    headers.set("X-CSRF-Token", csrfToken);
  }
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || "Произошла ошибка. Попробуйте ещё раз.");
  return data;
}

async function loadSession() {
  const session = await api("/api/session");
  csrfToken = session.csrfToken;
  authenticated = session.authenticated;
  updateAdminUI();
}

function updateAdminUI() {
  $("#admin-button").textContent = authenticated ? "Панель управления" : "Войти";
  $("#admin-status").classList.toggle("hidden", !authenticated);
  $("#admin-panel").classList.toggle("hidden", !authenticated);
  if (authenticated) {
    loadAdminEpisodes().catch((error) => showToast(error.message));
  }
}

function renderEpisodes() {
  $("#episode-total").textContent = `${episodes.length} ${episodes.length === 1 ? "СЕРИЯ" : "СЕРИИ"}`;
  const grid = $("#episodes-grid");
  if (!episodes.length) {
    grid.innerHTML = '<div class="loading-card">Пока нет серий. Администратор может добавить их в панели управления.</div>';
    return;
  }

  grid.innerHTML = episodes.map((episode, index) => `
    <article class="episode-card">
      <div class="episode-top">
        <span class="episode-index">ЭПИЗОД ${String(index + 1).padStart(2, "0")}</span>
        <span class="episode-state">${episode.videoAvailable ? "ДОСТУПНО" : "СКОРО"}</span>
      </div>
      <h3>${escapeHtml(episode.title)}</h3>
      <p>${escapeHtml(episode.description || "Серия сериала «Бессмертный».")}</p>
      <button class="episode-watch" type="button" data-watch-id="${episode.id}" ${episode.videoAvailable ? "" : "disabled"}>
        ${episode.videoAvailable ? "▶ Смотреть серию" : "Видео скоро появится"}
      </button>
    </article>
  `).join("");
}

async function loadEpisodes() {
  episodes = await api("/api/episodes");
  renderEpisodes();
  if (authenticated) await loadAdminEpisodes();
}

function openLogin() {
  $("#login-message").textContent = "";
  $("#login-message").classList.remove("error");
  $("#login-form").reset();
  $("#login-modal").classList.remove("hidden");
  setTimeout(() => $("#login-username").focus(), 50);
}

function closeLogin() {
  $("#login-modal").classList.add("hidden");
}

function openPlayer(episode) {
  $("#player-title").textContent = episode.title;
  $("#player-description").textContent = episode.description || "";
  $("#player-episode-label").textContent = `БЕССМЕРТНЫЙ · ${episode.title.toUpperCase()}`;
  const player = $("#video-player");
  player.src = episode.videoUrl;
  $("#player-modal").classList.remove("hidden");
  player.play().catch(() => {});
}

function closePlayer() {
  const player = $("#video-player");
  player.pause();
  player.removeAttribute("src");
  player.load();
  $("#player-modal").classList.add("hidden");
}

async function loadAdminEpisodes() {
  const rows = await api("/api/admin/episodes");
  const select = $("#episode-action");
  const currentValue = select.value;
  select.innerHTML = '<option value="">Добавить новую серию</option>' +
    rows.map((ep) => `<option value="${ep.id}">Загрузить / заменить видео: ${escapeHtml(ep.title)}</option>`).join("");
  if ([...select.options].some((option) => option.value === currentValue)) {
    select.value = currentValue;
  }

  $("#admin-episodes").innerHTML = rows.map((ep, index) => `
    <div class="admin-episode-row">
      <div>
        <div class="admin-episode-name">${String(index + 1).padStart(2, "0")} · ${escapeHtml(ep.title)}</div>
        <div class="admin-episode-state">${ep.videoAvailable ? "Видео загружено" : "Ожидает загрузки видео"}</div>
      </div>
      <button class="delete-episode" type="button" data-delete-id="${ep.id}">Удалить</button>
    </div>
  `).join("");
}

$("#admin-button").addEventListener("click", () => {
  if (!authenticated) {
    openLogin();
    return;
  }
  $("#admin-panel").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.querySelectorAll("[data-close-login]").forEach((el) => el.addEventListener("click", closeLogin));
document.querySelectorAll("[data-close-player]").forEach((el) => el.addEventListener("click", closePlayer));

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("#login-message");
  message.textContent = "Проверяем данные…";
  message.classList.remove("error");
  const form = new FormData(event.currentTarget);

  try {
    const result = await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: form.get("username"),
        password: form.get("password")
      })
    });
    csrfToken = result.csrfToken;
    authenticated = true;
    closeLogin();
    updateAdminUI();
    await loadAdminEpisodes();
    showToast("Вход выполнен. Панель администратора открыта.");
    $("#admin-panel").scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
});

$("#logout-button").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
    authenticated = false;
    await loadSession();
    showToast("Вы вышли из аккаунта.");
  } catch (error) {
    showToast(error.message);
  }
});

$("#episodes-grid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-watch-id]");
  if (!button || button.disabled) return;
  const episode = episodes.find((item) => item.id === Number(button.dataset.watchId));
  if (episode?.videoAvailable) openPlayer(episode);
});

$("#episode-action").addEventListener("change", () => {
  const selectedId = Number($("#episode-action").value);
  if (!selectedId) {
    $("#episode-title").value = `Серия ${episodes.length + 1}`;
    $("#episode-description").value = "";
    return;
  }
  const episode = episodes.find((item) => item.id === selectedId);
  if (episode) {
    $("#episode-title").value = episode.title;
    $("#episode-description").value = episode.description || "";
  }
});

$("#episode-video").addEventListener("change", () => {
  const file = $("#episode-video").files[0];
  $("#file-label").textContent = file ? file.name : "Выбрать видео";
});

$("#upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const message = $("#upload-message");
  button.disabled = true;
  button.textContent = "Загрузка…";
  message.classList.remove("error");
  message.textContent = "Загружаем видео на сервер. Не закрывай страницу.";

  const formData = new FormData(event.currentTarget);
  try {
    await api("/api/admin/episodes", { method: "POST", body: formData });
    message.textContent = "Готово! Серия сохранена.";
    event.currentTarget.reset();
    $("#episode-title").value = `Серия ${episodes.length + 1}`;
    $("#file-label").textContent = "Выбрать видео";
    await loadEpisodes();
    await loadAdminEpisodes();
    showToast("Серия успешно опубликована.");
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  } finally {
    button.disabled = false;
    button.innerHTML = 'Загрузить серию <span>↗</span>';
  }
});

$("#admin-episodes").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-id]");
  if (!button) return;
  const episode = episodes.find((item) => item.id === Number(button.dataset.deleteId));
  const name = episode?.title || "эту серию";
  if (!window.confirm(`Удалить «${name}» вместе с видеофайлом?`)) return;

  try {
    await api(`/api/admin/episodes/${button.dataset.deleteId}`, { method: "DELETE" });
    await loadEpisodes();
    await loadAdminEpisodes();
    showToast("Серия удалена.");
  } catch (error) {
    showToast(error.message);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeLogin();
    closePlayer();
  }
});

async function init() {
  try {
    await loadSession();
    await loadEpisodes();
    $("#episode-title").value = `Серия ${episodes.length + 1}`;
  } catch (error) {
    $("#episodes-grid").innerHTML = `<div class="loading-card">${escapeHtml(error.message)}</div>`;
  }
}

init();
