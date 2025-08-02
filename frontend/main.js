// frontend/main.js

document.addEventListener("DOMContentLoaded", () => {
  const BACKEND_URL = "https://vibes-fqic.onrender.com";

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

  // --- JWT AUTHENTICATION FLOW ---

  // 1. Check for a token in the URL query parameters (from Google OAuth redirect).
    const urlParams = new URLSearchParams(window.location.search);
  const tokenFromUrl = urlParams.get('token');
  const redirectFromUrl = urlParams.get('redirect');

  if (tokenFromUrl) {
    localStorage.setItem('vibe_token', tokenFromUrl);
    // We are now logged in.
    
    // Clear the redirect path from localStorage, as we've successfully used it.
    localStorage.removeItem('redirect_after_login');
    
    if (redirectFromUrl) {
      // If a redirect URL is present, GO THERE IMMEDIATELY.
      window.location.href = redirectFromUrl;
      return; // Stop executing the rest of the main.js script.
    } else {
      // If no redirect, just clean the URL and stay on the homepage.
      window.history.replaceState({}, document.title, "/");
    }
  }

  // 2. Retrieve the token from localStorage.
  const userToken = localStorage.getItem('vibe_token');

  if (userToken) {
    // 3. If a token exists, try to fetch the user's profile.
    fetch(`${BACKEND_URL}/api/user`, {
      headers: {
        // Include the token in the Authorization header.
        'Authorization': `Bearer ${userToken}`
      }
    })
    .then(res => {
        if (!res.ok) {
            // If the token is invalid or expired, clear it and reject the promise.
            localStorage.removeItem('vibe_token');
            return Promise.reject("Not authenticated");
        }
        return res.json();
    })
    .then(user => {
        if (user && user.id) {
            // If user is successfully fetched, set up the logged-in UI.
            setupLoggedInUI(user, userToken);
        }
    })
    .catch(() => {
        // If fetch fails for any reason, show the logged-out view.
        loggedOutView.style.display = "block";
        loggedInView.style.display = "none";
    });
  } else {
      loggedOutView.style.display = "block";
    loggedInView.style.display = "none";
    
    // --- THIS IS THE FIX ---
    // Check for a saved redirect path in localStorage.
    const redirectPath = localStorage.getItem('redirect_after_login');
    let googleAuthUrl = `${BACKEND_URL}/auth/google`;

    if (redirectPath) {
      // If a path exists, encode it and append it to the auth URL.
      googleAuthUrl += `?redirect=${encodeURIComponent(redirectPath)}`;
    }

    // Find the login button and set its href dynamically.
    const loginButton = loggedOutView.querySelector('.btn-primary');
    if (loginButton) {
      loginButton.href = googleAuthUrl;
    }
  }


  // This function is now only called AFTER a user is successfully authenticated via JWT.
  function setupLoggedInUI(user, token) {
    loggedOutView.style.display = "none";
    loggedInView.style.display = "block";

    // The logout link needs to be handled by the frontend now to clear the token
    navActions.innerHTML = `
        <p class="nav-link">Welcome, ${user.displayName}!</p>
        <button id="logout-btn" class="btn btn-secondary">Log Out</button>
    `;

    document.getElementById('logout-btn').addEventListener('click', () => {
        localStorage.removeItem('vibe_token');
        window.location.href = '/'; // Redirect to home page
    });

    // --- SOCKET.IO CONNECTION WITH JWT ---
    const socket = io(BACKEND_URL, {
        auth: {
            token: token // Send the JWT for socket authentication
        }
    });

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
                    </div>
                `;
                roomCard.addEventListener("click", () => {
                    window.location.href = `/room/${room.slug}`;
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
    socket.on("roomCreated", ({ slug }) => {
        window.location.href = `/room/${slug}`;
    });

    // Initial fetch of rooms
    socket.emit("getRooms");
  }
});