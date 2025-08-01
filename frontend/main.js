// public/js/main.js

document.addEventListener("DOMContentLoaded", () => {
  // +++ CHANGE START: Define backend URL and update socket connection +++
  const BACKEND_URL = "https://vibes-fqic.onrender.com";
   const socket = io(); 
  // +++ CHANGE END +++

  // --- Core DOM Elements ---
  const navActions = document.querySelector(".nav-actions");
  const loggedOutView = document.getElementById("logged-out-view");
  const loggedInView = document.getElementById("logged-in-view");
  const roomsGrid = document.querySelector(".rooms-grid");
  const noRoomsMessage = document.getElementById("no-rooms-message");

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

  // --- Check Authentication Status on Page Load ---
  // +++ CHANGE: Update fetch URL to point to backend +++
   fetch(`/api/user`) 
    .then((res) => { // ... updated logic for cleaner auth flow
      if (!res.ok) return Promise.reject("Not authenticated");
      return res.json();
    })
    .then((user) => {
      if (user && user.id) {
        setupLoggedInUI(user);
      } else {
        throw new Error("User not found or not authenticated");
      }
    })
    .catch(() => {
      loggedOutView.style.display = "block";
      loggedInView.style.display = "none";
    });

  function setupLoggedInUI(user) {
    loggedOutView.style.display = "none";
    loggedInView.style.display = "block";

    // REVERT: Logout link is relative. Vercel will proxy it.
    navActions.innerHTML = `
            <p class="nav-link">Welcome, ${user.displayName}!</p>
            <a href="/logout" class="btn btn-secondary">Log Out</a>
        `;

    // --- ALL LOGGED-IN LOGIC NOW LIVES INSIDE THIS FUNCTION SCOPE ---

    let selectedVibe = null;
    let allRooms = [];
    let currentFilter = "All";

    // --- Modal Functions ---
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

    // --- Lobby Rendering & Filtering ---
    function renderVibeTags(vibes) {
      const container = document.getElementById("vibe-tag-cloud");
      if (!container) return;
      container.innerHTML = "";

      const allBtn = document.createElement("button");
      allBtn.className = "vibe-tag";
      allBtn.textContent = "All";
      allBtn.dataset.vibeName = "All";
      if (currentFilter === "All") allBtn.classList.add("active");
      allBtn.addEventListener("click", () => setFilter("All"));
      container.appendChild(allBtn);

      vibes.forEach((vibe) => {
        if (vibe.count > 0 || vibe.type === "PRESET") {
          const tagBtn = document.createElement("button");
          tagBtn.className = "vibe-tag";
          tagBtn.dataset.vibeName = vibe.name;
          tagBtn.innerHTML = `${vibe.name} <span class="tag-count">(${vibe.count})</span>`;
          if (currentFilter === vibe.name) tagBtn.classList.add("active");
          tagBtn.addEventListener("click", () => setFilter(vibe.name));
          container.appendChild(tagBtn);
        }
      });
    }

    function setFilter(vibeName) {
      currentFilter = vibeName;
      const container = document.getElementById("vibe-tag-cloud");
      container.querySelectorAll(".vibe-tag").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.vibeName === vibeName);
      });
      renderFilteredRooms();
    }

    function renderFilteredRooms() {
      let roomsToRender = allRooms;
      if (currentFilter !== "All") {
        roomsToRender = allRooms.filter(
          (room) => room.vibe && room.vibe.name === currentFilter
        );
      }
      updateRoomsList(roomsToRender);
    }

    function updateRoomsList(rooms) {
      if (!roomsGrid) return;
      roomsGrid.innerHTML = "";
      if (rooms.length === 0) {
        noRoomsMessage.style.display = "block";
      } else {
        noRoomsMessage.style.display = "none";
        rooms.forEach((room) => {
          const roomCard = document.createElement("div");
          roomCard.className = "room-card";
          const albumArtUrl =
            room.nowPlaying && room.nowPlaying.track
              ? room.nowPlaying.track.albumArt
              : "/assets/placeholder.svg";
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
                        </div>
                    `;
          roomCard.addEventListener("click", () => {
            window.location.href = `/room/${room.id}`;
          });
          roomsGrid.appendChild(roomCard);
        });
      }
    }

    // --- Attach all Event Listeners for Logged-In state ---

    // Modal Listeners
    createRoomBtn.addEventListener("click", showModal);
    closeModalBtn.addEventListener("click", hideModal);
    modalOverlay.addEventListener("click", (e) => {
      if (e.target === modalOverlay) hideModal();
    });
    presetVibeBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        presetVibeBtns.forEach((otherBtn) =>
          otherBtn.classList.remove("active")
        );
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
      if (!selectedVibe || !selectedVibe.name)
        return alert("Please select a preset vibe or create a custom one.");
      socket.emit("createRoom", { roomName, vibe: selectedVibe });
      hideModal();
    });

    // Socket Listeners
    socket.on("updateLobby", ({ rooms, vibes }) => {
      allRooms = rooms;
      renderVibeTags(vibes);
      renderFilteredRooms();
    });
    socket.on("roomCreated", ({ roomId }) => {
      window.location.href = `/room/${roomId}`;
    });

    // Initial fetch of rooms
    socket.emit("getRooms");
  }
});
