document.addEventListener("DOMContentLoaded", () => {
  const BACKEND_URL = "https://vibes-fqic.onrender.com"; 
  const googleNav = document.getElementById("google-login-btn-nav");
  const googleHero = document.getElementById("google-login-btn-hero");
  const ctaDemo = document.getElementById("cta-demo");
  const createRoomBtn = document.getElementById("create-room-btn");
  const modal = document.getElementById("create-room-modal");
  const modalClose = document.getElementById("modal-close");
  const modalCancel = document.getElementById("modal-cancel-btn");
  const modalCreate = document.getElementById("modal-create-btn");
  const roomNameInput = document.getElementById("room-name-input");
  const presetVibesContainer = document.getElementById("preset-vibes-container");
  const presetVibeBtns = presetVibesContainer?.querySelectorAll(".vibe-tag") || [];
  const customVibeInput = document.getElementById("custom-vibe-input");
  const roomsGrid = document.getElementById("rooms-grid");
  const noRooms = document.getElementById("no-rooms");
  const vibeTagCloud = document.getElementById("vibe-tag-cloud");
  const toastsRoot = document.getElementById("toasts");
  const modalError = document.getElementById("modal-error");
  const heroAlbum = document.getElementById("hero-album");

  let allRooms = [];
  let currentFilter = "All";
  let selectedVibe = null;

  function toast(message, { type = "success", timeout = 3500 } = {}) {
    const el = document.createElement("div");
    el.className = `toast ${type === "error" ? "error" : "success"}`;
    el.textContent = message;
    toastsRoot.appendChild(el);
    setTimeout(() => {
      el.style.transform = "translateY(8px)";
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 300);
    }, timeout);
    return el;
  }

  const redirectPath = localStorage.getItem("redirect_after_login") || "";
  function buildGoogleUrl() {
    let url = `${BACKEND_URL}/auth/google`;
    if (redirectPath) url += `?redirect=${encodeURIComponent(redirectPath)}`;
    return url;
  }
  if (googleNav) googleNav.href = buildGoogleUrl();
  if (googleHero) googleHero.href = buildGoogleUrl();

  const urlParams = new URLSearchParams(window.location.search);
  const tokenFromUrl = urlParams.get("token");
  const redirectFromUrl = urlParams.get("redirect");
  if (tokenFromUrl) {
    localStorage.setItem("vibe_token", tokenFromUrl);
    localStorage.removeItem("redirect_after_login");
    if (redirectFromUrl) {
      window.location.href = redirectFromUrl;
      return;
    } else {
      history.replaceState({}, "", "/");
    }
  }

  if (ctaDemo) {
    ctaDemo.addEventListener("click", () => {
      toast("Demo: redirecting to a sample room...", { timeout: 2000 });
   
      setTimeout(() => window.location.href = "/room/demo-room", 700);
    });
  }

  function openModal() {
    modal.setAttribute("aria-hidden", "false");
    modal.style.display = "flex";
    roomNameInput.focus();
  }
  function closeModal() {
    modal.setAttribute("aria-hidden", "true");
    modal.style.display = "none";
    modalError.style.display = "none";
    roomNameInput.value = "";
    customVibeInput.value = "";
    presetVibeBtns.forEach(b => b.classList.remove("active"));
    selectedVibe = null;
  }
  createRoomBtn && createRoomBtn.addEventListener("click", openModal);
  modalClose && modalClose.addEventListener("click", closeModal);
  modalCancel && modalCancel.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  presetVibeBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      presetVibeBtns.forEach(b => b.classList.remove("active"));
      customVibeInput.value = "";
      btn.classList.add("active");
      selectedVibe = { name: btn.dataset.vibeName, type: "PRESET" };
    });
  });

  customVibeInput && customVibeInput.addEventListener("input", (e) => {
    const v = e.target.value.trim();
    if (v) {
      presetVibeBtns.forEach(b => b.classList.remove("active"));
      selectedVibe = { name: v, type: "CUSTOM" };
    } else {
      selectedVibe = null;
    }
  });

  modalCreate && modalCreate.addEventListener("click", () => {
    const name = (roomNameInput.value || "").trim();
    if (!name) {
      modalError.textContent = "Please enter a room name.";
      modalError.style.display = "block";
      return;
    }
    if (!selectedVibe || !selectedVibe.name) {
      modalError.textContent = "Please pick a preset vibe or enter a custom vibe.";
      modalError.style.display = "block";
      return;
    }

    const token = localStorage.getItem("vibe_token");
    if (!token) {
      localStorage.setItem("redirect_after_login", `/`);
      window.location.href = `${BACKEND_URL}/auth/google?redirect=${encodeURIComponent(`/`)}`
      return;
    }

    const s = io(BACKEND_URL, { auth: { token } });
    s.on("connect_error", () => {
      toast("Unable to contact server. Try again later.", { type: "error" });
      s.disconnect();
    });
    s.emit("createRoom", { roomName: name, vibe: selectedVibe });
    s.on("roomCreated", ({ slug }) => {
      toast("Room created! Redirecting...", { timeout: 1500 });
      setTimeout(() => window.location.href = `/room/${slug}`, 700);
    });
    s.on("error", (err) => {
      toast(err?.message || "An error occurred", { type: "error" });
      s.disconnect();
    });
    closeModal();
  });

  function buildRoomCard(room) {
    const el = document.createElement("div");
    el.className = "room-card";

    const album = (room.nowPlaying && room.nowPlaying.track && room.nowPlaying.track.albumArt) || "/placeholder.svg";
    el.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0.0), rgba(0,0,0,0.42)), url('${album}')`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
    el.innerHTML = `
      <div class="info">
        <div class="room-name">${escapeHtml(room.name)}</div>
        <div class="room-meta">
          <div class="listeners">👥 ${room.listenerCount}</div>
          <div class="muted"> · ${room.vibe?.name || 'Vibe'}</div>
        </div>
      </div>
    `;
    el.addEventListener("click", () => {
      window.location.href = `/room/${room.slug}`;
    });
    return el;
  }

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, (m)=> ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

  function renderRooms(rooms) {
    roomsGrid.innerHTML = "";
    if (!rooms || rooms.length === 0) {
      noRooms.style.display = "block";
      return;
    }
    noRooms.style.display = "none";
    rooms.forEach(r => roomsGrid.appendChild(buildRoomCard(r)));
  }

  function renderVibeTags(vibes) {
    vibeTagCloud.innerHTML = "";

    const allBtn = document.createElement("button");
    allBtn.className = "vibe-tag" + (currentFilter === "All" ? " active" : "");
    allBtn.textContent = "All";
    allBtn.dataset.vibeName = "All";
    allBtn.addEventListener("click", () => { currentFilter = "All"; renderFiltered(); });
    vibeTagCloud.appendChild(allBtn);

    (vibes || []).forEach(v => {
      const btn = document.createElement("button");
      btn.className = "vibe-tag" + (currentFilter === v.name ? " active" : "");
      btn.innerText = `${v.name} (${v.count || 0})`;
      btn.dataset.vibeName = v.name;
      btn.addEventListener("click", () => { currentFilter = v.name; renderFiltered(); });
      vibeTagCloud.appendChild(btn);
    });
  }

  function renderFiltered() {
    let toShow = allRooms;
    if (currentFilter !== "All") toShow = allRooms.filter(r => r.vibe && r.vibe.name === currentFilter);
    renderRooms(toShow);
  }

  function connectLobbySocket(token) {
    const s = io(BACKEND_URL, { auth: { token } });
    s.on("connect", () => console.log("Lobby socket connected"));
    s.on("connect_error", (err) => {
      console.warn("Socket connect error:", err);
      toast("Cannot connect to live lobby. Refresh to retry.", { type: "error" });
    });
    s.on("updateLobby", ({ rooms = [], vibes = [] } = {}) => {
      allRooms = rooms;
      renderVibeTags(vibes);
      renderFiltered();
    });
    s.on("roomCreated", ({ slug }) => {

      window.location.href = `/room/${slug}`;
    });
    s.on("toast", (data) => {
      if (data && data.message) toast(data.message, { type: data.type === 'error' ? 'error' : 'success' });
    });
  }

  const userToken = localStorage.getItem("vibe_token");
  if (userToken) {

    fetch(`${BACKEND_URL}/api/user`, { headers: { Authorization: `Bearer ${userToken}` } })
      .then(r => { if (!r.ok) throw new Error("Not authenticated"); return r.json(); })
      .then(user => {
     
        const nav = document.querySelector(".nav-actions");
        nav.innerHTML = `<span class="muted">Welcome, ${user.displayName}</span> <button id="logout-btn" class="btn ghost">Log out</button>`;
        document.getElementById("logout-btn").addEventListener("click", () => {
          localStorage.removeItem("vibe_token");
          location.reload();
        });

        connectLobbySocket(userToken);
      })
      .catch(() => {
     
        if (googleNav) googleNav.href = buildGoogleUrl();
        if (googleHero) googleHero.href = buildGoogleUrl();
       
      });
  } else {

    if (googleNav) googleNav.href = buildGoogleUrl();
    if (googleHero) googleHero.href = buildGoogleUrl();
  }

  (function setHeroAlbum(){
    const grads = [
      "linear-gradient(135deg,#f97316,#fb7185)",
      "linear-gradient(135deg,#60a5fa,#7c3aed)",
      "linear-gradient(135deg,#34d399,#06b6d4)",
      "linear-gradient(135deg,#f472b6,#fb923c)"
    ];
    if (heroAlbum) heroAlbum.style.background = grads[Math.floor(Math.random()*grads.length)];
  })();

  window.__vibes_ui = { toast, openModal, closeModal };
});
