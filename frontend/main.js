document.addEventListener("DOMContentLoaded", () => {
  const BACKEND_URL = "https://vibes-fqic.onrender.com";
  const body = document.body;

  const navActions = document.querySelector(".nav-actions");
  
  // Containers for Logged-In View
  const loggedInVibeTagCloud = document.getElementById("vibe-tag-cloud");
  const loggedInRoomsGrid = document.querySelector("#logged-in-view .rooms-grid");
  const noLoggedInRoomsMessage = document.getElementById("no-rooms-message");
  
  // Containers for Guest View
  const publicVibeTagCloud = document.getElementById("public-vibe-tag-cloud");
  const publicRoomsList = document.getElementById("public-rooms-list");
  const noPublicRoomsMessage = document.getElementById(
    "no-public-rooms-message"
  );

  // Modal elements
  const createRoomBtn = document.getElementById("create-room-btn");
  const modalOverlay = document.getElementById("create-room-modal");
  const closeModalBtn = document.getElementById("close-modal-btn");
  const roomNameInput = document.getElementById("room-name-input");
  const presetVibesContainer = document.getElementById(
    "preset-vibes-container"
  );
  const presetVibeBtns = presetVibesContainer.querySelectorAll(".vibe-tag");
  const customVibeInput = document.getElementById("custom-vibe-input");
  const modalCreateBtn = document.getElementById("modal-create-btn");

  const urlParams = new URLSearchParams(window.location.search);
  const tokenFromUrl = urlParams.get("token");

  if (tokenFromUrl) {
    localStorage.setItem("vibe_token", tokenFromUrl);
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  const userToken = localStorage.getItem("vibe_token");

  if (userToken) {
    fetch(`${BACKEND_URL}/api/user`, {
      headers: { Authorization: `Bearer ${userToken}` },
    })
      .then((res) => {
        if (!res.ok) {
          localStorage.removeItem("vibe_token");
          throw new Error("Token invalid");
        }
        return res.json();
      })
      .then((user) => setupLoggedInUI(user, userToken))
      .catch(() => setupGuestUI());
  } else {
    setupGuestUI();
  }

  function setupAuthRedirects() {
    let googleAuthUrl = `${BACKEND_URL}/auth/google`;
    const loginButtons = document.querySelectorAll(
      "#google-login-btn-nav, #google-login-btn-hero, #google-login-btn-cta"
    );
    loginButtons.forEach((button) => {
      if (button) button.href = googleAuthUrl;
    });
  }

  function setupGuestUI() {
    body.className = "is-guest";
    setupAuthRedirects();
    connectToSocket(null);
  }

  function setupLoggedInUI(user, token) {
    body.className = "is-authenticated";
    navActions.innerHTML = `
        <p class="nav-link">Welcome, ${user.displayName}!</p>
        <button id="logout-btn" class="btn btn-secondary">Log Out</button>
    `;
    document.getElementById("logout-btn").addEventListener("click", () => {
      localStorage.removeItem("vibe_token");
      window.location.href = "/";
    });
    connectToSocket(token);
  }

  function connectToSocket(token) {
    const socket = io(BACKEND_URL, { auth: { token: token } });

    let selectedVibe = null;
    let allRooms = [];
    let allVibes = [];
    let currentFilter = "All";

    const isGuest = !token;

    function renderContent() {
        if (isGuest) {
            renderVibeTags(publicVibeTagCloud, allVibes, currentFilter, setFilter);
            renderFilteredRooms(publicRoomsList, noPublicRoomsMessage, allRooms, currentFilter);
        } else {
            renderVibeTags(loggedInVibeTagCloud, allVibes, currentFilter, setFilter);
            renderFilteredRooms(loggedInRoomsGrid, noLoggedInRoomsMessage, allRooms, currentFilter);
        }
    }

    function setFilter(vibeName) {
        currentFilter = vibeName;
        renderContent();
    }

    if (!isGuest) {
        createRoomBtn.addEventListener("click", showModal);
        closeModalBtn.addEventListener("click", hideModal);
        modalOverlay.addEventListener("click", (e) => {
            if (e.target === modalOverlay) hideModal();
        });
        presetVibeBtns.forEach((btn) => {
            btn.addEventListener("click", () => {
                presetVibeBtns.forEach((otherBtn) => otherBtn.classList.remove("active"));
                customVibeInput.value = "";
                btn.classList.add("active");
                selectedVibe = { name: btn.dataset.vibeName, type: "PRESET" };
            });
        });
        customVibeInput.addEventListener("input", () => {
            if (customVibeInput.value.trim() !== "") {
                presetVibeBtns.forEach((btn) => btn.classList.remove("active"));
                selectedVibe = { name: customVibeInput.value.trim(), type: "CUSTOM" };
            } else {
                selectedVibe = null;
            }
        });
        modalCreateBtn.addEventListener("click", () => {
            const roomName = roomNameInput.value.trim();
            if (!roomName) return alert("Please enter a room name.");
            if (!selectedVibe || !selectedVibe.name) return alert("Please select a preset vibe or create a custom one.");
            window.va && window.va("event", "Create Room", { vibe: selectedVibe.name });
            socket.emit("createRoom", { roomName, vibe: selectedVibe });
            hideModal();
        });
        socket.on("roomCreated", ({ slug }) => {
            window.location.href = `/room/${slug}`;
        });
    }

    function showModal() {
        modalOverlay.style.display = "flex";
        setTimeout(() => modalOverlay.classList.add("visible"), 10);
    }

    function hideModal() {
        modalOverlay.classList.remove("visible");
        setTimeout(() => {
            modalOverlay.style.display = "none";
            roomNameInput.value = "";
            customVibeInput.value = "";
            presetVibeBtns.forEach((btn) => btn.classList.remove("active"));
            selectedVibe = null;
        }, 300);
    }
    
    socket.on("updateLobby", ({ rooms, vibes }) => {
        allRooms = rooms;
        allVibes = vibes;
        renderContent();
    });

    socket.emit("getRooms");
  }
});

function renderVibeTags(container, vibes, activeFilter, setFilterCallback) {
    if (!container) return;
    container.innerHTML = "";

    const allBtn = document.createElement("button");
    allBtn.className = "vibe-tag";
    allBtn.textContent = "All";
    allBtn.dataset.vibeName = "All";
    if (activeFilter === "All") allBtn.classList.add("active");
    allBtn.addEventListener("click", () => setFilterCallback("All"));
    container.appendChild(allBtn);

    vibes.forEach((vibe) => {
        if (vibe.count > 0 || vibe.type === "PRESET") {
            const tagBtn = document.createElement("button");
            tagBtn.className = "vibe-tag";
            tagBtn.dataset.vibeName = vibe.name;
            tagBtn.innerHTML = `${vibe.name} <span class="tag-count">(${vibe.count})</span>`;
            if (activeFilter === vibe.name) tagBtn.classList.add("active");
            tagBtn.addEventListener("click", () => setFilterCallback(vibe.name));
            container.appendChild(tagBtn);
        }
    });
}

function renderFilteredRooms(grid, noRoomsMsg, allRooms, filter) {
    let roomsToRender = (filter === "All")
        ? allRooms
        : allRooms.filter((r) => r.vibe && r.vibe.name === filter);

    // Sort by listener count (descending) and take the top 6
    const topRooms = roomsToRender
        .sort((a, b) => b.listenerCount - a.listenerCount)
        .slice(0, 6);

    updateRoomsList(grid, noRoomsMsg, topRooms);
}


function updateRoomsList(grid, noRoomsMsg, rooms) {
  if (!grid) return;
  grid.innerHTML = "";
  if (rooms.length === 0) {
    noRoomsMsg.style.display = "block";
    grid.style.display = "none";
  } else {
    noRoomsMsg.style.display = "none";
    grid.style.display = "flex"; // Ensure it's using flex
    rooms.forEach((room) => {
      const roomCard = document.createElement("div");
      roomCard.className = "room-card";
      const albumArtUrl =
        room.nowPlaying && room.nowPlaying.track
          ? room.nowPlaying.track.albumArt
          : "/placeholder.svg";
      if (room.nowPlaying && room.nowPlaying.track) {
        roomCard.style.backgroundImage = `url(${albumArtUrl})`;
      }
      roomCard.innerHTML = `
          <img src="${albumArtUrl}" alt="${room.name}" class="album-art"/>
          <div class="room-card-info">
              <h3 class="room-name">${room.name}</h3>
              <div class="room-card-footer">
                  <div class="room-listeners">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                      <span>${room.listenerCount} listeners</span>
                  </div>
                  <div class="status-indicator">
                      <div class="status-dot"></div><span>LIVE</span>
                  </div>
              </div>
          </div>`;
      roomCard.addEventListener("click", () => {
        window.location.href = `/room/${room.slug}`;
      });
      grid.appendChild(roomCard);
    });
  }
}