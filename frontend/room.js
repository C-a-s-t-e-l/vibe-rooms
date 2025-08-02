// frontend/room.js

document.addEventListener("DOMContentLoaded", () => {
  const BACKEND_URL = "https://vibes-fqic.onrender.com";
  const userToken = localStorage.getItem("vibe_token");
  const volumeSlider = document.getElementById('volume-slider');
  const savedVolume = localStorage.getItem('vibe_volume') || 80; 
  volumeSlider.value = savedVolume;

  if (!userToken) {
    window.location.href = "/";
    return;
  }

  const socket = io(BACKEND_URL, { auth: { token: userToken } });

  let player;
  let initialNowPlayingData = null;
  let lastSeekTimestamp = 0;

  window.onYouTubeIframeAPIReady = function () {
    console.log("YouTube Iframe API is ready.");
    player = new YT.Player("youtube-player", {
      height: "0",
      width: "0",
      playerVars: { playsinline: 1, controls: 0, disablekb: 1 },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange,
      },
    });
  };

  function onPlayerReady(event) {
    console.log("Player is ready to be controlled.");
    const volumeSlider = document.getElementById("volume-slider");
    if (player && player.setVolume) {
      player.setVolume(volumeSlider.value);
    }
    if (initialNowPlayingData) {
      console.log("Syncing to stored initial state now that player is ready.");
      syncPlayerState(initialNowPlayingData);
      initialNowPlayingData = null;
    }
  }

  function onPlayerStateChange(event) {
    if (event.data === YT.PlayerState.ENDED) {
      if (isHost) socket.emit("skipTrack", { roomId: currentRoomId });
    }
    const isPlaying = event.data === YT.PlayerState.PLAYING;
    updatePlayPauseIcon(isPlaying);
    if (isPlaying) {
      if (
        isHost &&
        currentPlaylistState &&
        currentPlaylistState.playlist[currentPlaylistState.nowPlayingIndex]
      ) {
        const currentTrack =
          currentPlaylistState.playlist[currentPlaylistState.nowPlayingIndex];
        if (currentTrack.duration_ms === 0) {
          const realDurationMs = player.getDuration() * 1000;
          if (realDurationMs > 0) {
            console.log(
              `Host is updating duration for track ${currentPlaylistState.nowPlayingIndex} to ${realDurationMs}ms`
            );
            socket.emit("hostUpdateDuration", {
              roomId: currentRoomId,
              trackIndex: currentPlaylistState.nowPlayingIndex,
              durationMs: realDurationMs,
            });
            currentTrack.duration_ms = realDurationMs;
            currentSongDuration = realDurationMs;
          }
        }
      }
      const newStartTime = Date.now() - player.getCurrentTime() * 1000;
      startProgressTimer(newStartTime, currentSongDuration);
    } else {
      clearInterval(nowPlayingInterval);
    }
  }

  const formatTime = (ms) => {
    if (!ms || isNaN(ms)) return "0:00";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
  };

  const currentRoomSlug = window.location.pathname.split("/").pop();
  let currentRoomId = null;
  let nowPlayingInterval;
  let isHost = false,
    audioContextUnlocked = false,
    currentSongDuration = 0;
  let currentSuggestions = [];
  let currentPlaylistState = { playlist: [], nowPlayingIndex: -1 };

  const audioUnlockOverlay = document.getElementById("audio-unlock-overlay");
  const playPauseBtn = document.getElementById("play-pause-btn");

  const playIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7Z"/></svg>`;
  const pauseIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M14 19h4V5h-4v14M6 19h4V5H6v14Z"/></svg>`;

  function unlockAudio() {
    if (audioContextUnlocked) return;
    audioContextUnlocked = true;
    audioUnlockOverlay.style.display = "none";
  }

  audioUnlockOverlay.addEventListener("click", unlockAudio);
  setupSocketListeners();
  setupUIEventListeners();
  socket.emit("joinRoom", currentRoomSlug);

  function setupSocketListeners() {
    socket.on("connect_error", (err) => {
      if (err.message.includes("unauthorized")) {
        localStorage.removeItem("vibe_token");
        window.location.href = "/";
      }
    });

    socket.on("roomState", (data) => {
  // 1. Guard clause: If no room data is received, redirect to home.
  if (!data) {
    window.location.href = "/";
    return;
  }

  // 2. Set up core room properties.
  currentRoomId = data.id;
  document.title = data.name;
  isHost = data.isHost;
  document.getElementById("room-name-display").textContent = data.name;
  document.getElementById("listener-count-display").textContent = data.listenerCount;

  // 3. Apply CSS classes based on user role (Host vs. Guest).
  // This is used to show/hide UI elements like the host-only forms and controls.
  const addVibeWrapper = document.getElementById("add-vibe-wrapper");
  addVibeWrapper.classList.toggle("is-host", isHost);
  addVibeWrapper.classList.toggle("is-guest", !isHost);
  
  // This is the logic for hiding the playback controls for guests.
  const hostControlsWrapper = document.getElementById("host-controls-wrapper");
  // By toggling the a parent class, all children with .host-only-controls will hide via CSS.
  hostControlsWrapper.classList.toggle("is-guest", !isHost);


  // 4. Update all the major UI components with the received state.
  currentPlaylistState = data.playlistState || { playlist: [], nowPlayingIndex: -1 };
  updatePlaylistUI(currentPlaylistState);

  currentSuggestions = data.suggestions || [];
  updateSuggestionsUI(currentSuggestions);

  updateUserListUI(data.userList || []);

  // 5. --> THIS IS THE NEW LOGIC FOR CHAT HISTORY <--
  // When joining, clear the chat and render the history sent from the server.
  const chatMessages = document.getElementById("chat-messages");
  chatMessages.innerHTML = ''; // Clear the container first
  if (data.chatHistory && data.chatHistory.length > 0) {
    data.chatHistory.forEach(message => {
      // We only render user messages from history to keep it clean.
      if (!message.system) {
        renderChatMessage(message);
      }
    });
  }

  // 6. Finally, synchronize the YouTube player state.
  syncPlayerState(data.nowPlaying);
});

    socket.on("newSongPlaying", (nowPlayingData) => {
      if (nowPlayingData && nowPlayingData.nowPlayingIndex !== undefined) {
        currentPlaylistState.nowPlayingIndex = nowPlayingData.nowPlayingIndex;
        updatePlaylistUI(currentPlaylistState);
      }
      syncPlayerState(nowPlayingData);
    });

    socket.on("syncPulse", (data) => {
      if (
        isHost ||
        !data ||
        !data.track ||
        !player ||
        typeof player.getPlayerState !== "function"
      )
        return;
      const latency = Date.now() - data.serverTimestamp;
      const authoritativePosition = data.position + latency;
      const clientPosition = player.getCurrentTime() * 1000;
      const drift = authoritativePosition - clientPosition;
      const now = Date.now();
      if (Math.abs(drift) > 150 && now - lastSeekTimestamp > 1000) {
        const trackDuration = player.getDuration() * 1000;
        if (authoritativePosition < trackDuration - 500) {
          console.log(
            `Syncing guest player. Drift: ${Math.round(drift)}ms. Seeking.`
          );
          player.seekTo(authoritativePosition / 1000, true);
          lastSeekTimestamp = now;
        }
      }
      const playerState = player.getPlayerState();
      if (data.isPlaying && playerState !== YT.PlayerState.PLAYING) {
        player.playVideo();
      } else if (
        !data.isPlaying &&
        (playerState === YT.PlayerState.PLAYING ||
          playerState === YT.PlayerState.BUFFERING)
      ) {
        player.pauseVideo();
      }
    });

    socket.on("hostAssigned", () => {
      isHost = true;
      document.getElementById("add-vibe-wrapper").classList.add("is-host");
      document.getElementById("add-vibe-wrapper").classList.remove("is-guest");
      document
        .getElementById("host-controls-wrapper")
        .classList.remove("is-guest");
      updatePlaylistUI(currentPlaylistState);
      updateSuggestionsUI(currentSuggestions);
    });

    socket.on("playlistUpdated", (playlistState) => {
      currentPlaylistState = playlistState;
      updatePlaylistUI(playlistState);
    });

    socket.on("suggestionsUpdated", (suggestions) => {
      currentSuggestions = suggestions;
      updateSuggestionsUI(suggestions);
    });

    socket.on("newChatMessage", (message) =>
      message.system
        ? renderSystemMessage(message.text)
        : renderChatMessage(message)
    );

    socket.on("updateUserList", (users) => {
      updateUserListUI(users);
    });

    socket.on("updateListenerCount", (count) => {
      document.getElementById("listener-count-display").textContent = count;
    });
  }

  function setupUIEventListeners() {
    playPauseBtn.addEventListener("click", () => {
      if (!isHost || !player || typeof player.getPlayerState !== "function")
        return;
      const playerState = player.getPlayerState();
      const newIsPlayingState = playerState !== YT.PlayerState.PLAYING;
      socket.emit("hostPlaybackChange", {
        roomId: currentRoomId,
        isPlaying: newIsPlayingState,
      });
      if (newIsPlayingState) player.playVideo();
      else player.pauseVideo();
    });

    document
      .getElementById("next-btn")
      .addEventListener(
        "click",
        () => isHost && socket.emit("skipTrack", { roomId: currentRoomId })
      );
    document
      .getElementById("prev-btn")
      .addEventListener(
        "click",
        () => isHost && socket.emit("playPrevTrack", { roomId: currentRoomId })
      );
    document.getElementById("volume-slider").addEventListener("input", (e) => {
      if (player && player.setVolume) player.setVolume(e.target.value);
      localStorage.setItem('vibe_volume', e.target.value);
    });

    document
      .getElementById("progress-bar-container")
      .addEventListener("click", (e) => {
        if (!isHost || !currentSongDuration || !player) return;
        const bar = document.getElementById("progress-bar-container");
        const seekRatio = e.offsetX / bar.clientWidth;
        const seekTimeMs = currentSongDuration * seekRatio;
        player.seekTo(seekTimeMs / 1000, true);
        if (player.getPlayerState() !== YT.PlayerState.PLAYING)
          player.playVideo();
        socket.emit("hostPlaybackChange", {
          roomId: currentRoomId,
          position: seekTimeMs,
        });
        startProgressTimer(Date.now() - seekTimeMs, currentSongDuration);
      });

    document.getElementById("chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const text = document.getElementById("chat-input").value.trim();
      if (text) {
        socket.emit("sendMessage", { roomId: currentRoomId, text });
        document.getElementById("chat-input").value = "";
      }
    });

    const handleLinkSubmit = async (e) => {
      e.preventDefault();
      const inputEl = isHost
        ? document.getElementById("host-link-input")
        : document.getElementById("guest-link-input");
      const url = inputEl.value.trim();
      if (!url) return;
      inputEl.value = "";
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
          url
        )}&format=json`;
        const response = await fetch(oembedUrl);
        if (!response.ok) {
          throw new Error("Could not fetch video information.");
        }
        const data = await response.json();
        const videoIdMatch = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/);
        if (!videoIdMatch || !videoIdMatch[1]) {
          throw new Error("Could not parse Video ID from URL.");
        }
        const videoId = videoIdMatch[1];
        const trackData = {
          videoId: videoId,
          name: data.title,
          artist: data.author_name,
          albumArt: data.thumbnail_url,
          duration_ms: 0,
          url: url,
          source: "youtube",
        };
        socket.emit("addYouTubeTrack", {
          roomId: currentRoomId,
          trackData: trackData,
        });
        showToast(isHost ? "Added to playlist!" : "Suggestion sent!");
      } catch (error) {
        console.error("Failed to add track:", error);
        showToast("Sorry, that link seems to be invalid.", "error");
      }
    };
    document
      .getElementById("host-link-form")
      .addEventListener("submit", handleLinkSubmit);
    document
      .getElementById("guest-link-form")
      .addEventListener("submit", handleLinkSubmit);

    // --- New Tab Logic ---
    const tabButtons = document.querySelectorAll(".tab-btn");
    const tabContents = document.querySelectorAll(".tab-content");
    tabButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.dataset.tab;
        tabButtons.forEach((btn) => btn.classList.remove("active"));
        button.classList.add("active");
        tabContents.forEach((content) => {
          content.classList.remove("active");
          if (content.id === `${tab}-content`) content.classList.add("active");
        });
      });
    });
  }

  function syncPlayerState(nowPlaying) {
    clearInterval(nowPlayingInterval);
    if (!nowPlaying || !nowPlaying.track) {
      updateNowPlayingUI(null, false);
      if (player && typeof player.stopVideo === "function") player.stopVideo();
      return;
    }
    if (!player || typeof player.loadVideoById !== "function") {
      console.warn(
        "Player not ready. Storing initial state to sync upon readiness."
      );
      initialNowPlayingData = nowPlaying;
      updateNowPlayingUI(nowPlaying, nowPlaying.isPlaying);
      return;
    }
    updateNowPlayingUI(nowPlaying, nowPlaying.isPlaying);
    const { track, isPlaying, position, serverTimestamp } = nowPlaying;
    const latency = Date.now() - serverTimestamp;
    const correctedPositionInSeconds = (position + latency) / 1000;
    player.loadVideoById(track.videoId, correctedPositionInSeconds);
    if (isPlaying) {
      if (audioContextUnlocked) player.playVideo();
      else audioUnlockOverlay.style.display = "grid";
    }
  }

  function startProgressTimer(startTime, duration_ms) {
    clearInterval(nowPlayingInterval);
    const update = () => {
      const elapsedTime = Date.now() - startTime;
      if (elapsedTime >= duration_ms) {
        clearInterval(nowPlayingInterval);
        document.getElementById("progress-bar").style.width = "100%";
        return;
      }
      document.getElementById("progress-bar").style.width = `${
        (elapsedTime / duration_ms) * 100
      }%`;
      document.getElementById("current-time").textContent =
        formatTime(elapsedTime);
    };
    nowPlayingInterval = setInterval(update, 500);
    update();
  }

  function updateNowPlayingUI(nowPlaying, isPlaying) {
    updatePlayPauseIcon(isPlaying);
    const artEl = document.getElementById("now-playing-art");
    const nameEl = document.getElementById("now-playing-name");
    const artistEl = document.getElementById("now-playing-artist");
    const bgEl = document.getElementById("room-background");
    const totalTimeEl = document.getElementById("total-time");
    if (!nowPlaying || !nowPlaying.track) {
      artEl.src = "/placeholder.svg";
      nameEl.textContent = "Nothing Playing";
      artistEl.textContent = "Add a YouTube link to start the vibe";
      bgEl.style.backgroundImage = "none";
      document.getElementById("progress-bar").style.width = "0%";
      document.getElementById("current-time").textContent = "0:00";
      totalTimeEl.textContent = "0:00";
      currentSongDuration = 0;
      return;
    }
    const { track } = nowPlaying;
    currentSongDuration = track.duration_ms;
    artEl.src = track.albumArt || "/placeholder.svg";
    nameEl.textContent = track.name;
    artistEl.textContent = track.artist;
    bgEl.style.backgroundImage = `url('${track.albumArt}')`;
    totalTimeEl.textContent = formatTime(track.duration_ms);
  }

  function updatePlayPauseIcon(isPlaying) {
    playPauseBtn.innerHTML = isPlaying ? pauseIcon : playIcon;
    const nowPlayingCard = document.getElementById("now-playing-container");
    if (nowPlayingCard) {
      nowPlayingCard.classList.toggle("is-playing", isPlaying);
    }
  }

  function showToast(message, type = "success") {
    const container = document.getElementById("toast-container");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 4000);
  }

  function renderChatMessage(message) {
    const chatMessages = document.getElementById("chat-messages");
    const msgDiv = document.createElement("div");
    msgDiv.className = "chat-message";
    msgDiv.innerHTML = `<img src="${message.avatar}" alt="${
      message.user
    }" class="chat-message__avatar"><div class="chat-message__content"><div class="chat-message__header"><span class="chat-message__username">${
      message.user
    }</span><span class="chat-message__timestamp">${new Date().toLocaleTimeString(
      [],
      { hour: "2-digit", minute: "2-digit" }
    )}</span></div><p class="chat-message__text">${message.text}</p></div>`;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  function renderSystemMessage(text) {
    const chatMessages = document.getElementById("chat-messages");
    const p = document.createElement("p");
    p.className = "system-message";
    p.textContent = text;
    chatMessages.appendChild(p);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function updateUserListUI(users) {
    const userList = document.getElementById("user-list");
    const userCountDisplay = document.getElementById("user-count-display");
    userList.innerHTML = "";
    userCountDisplay.textContent = `(${users.length})`;
    users.sort((a, b) => b.isHost - a.isHost);
    users.forEach((user) => {
      const userItem = document.createElement("div");
      userItem.className = "user-list-item";
      const hostIcon = user.isHost ? '<span class="host-icon">👑</span>' : "";
      userItem.innerHTML = `<img src="${user.avatar}" alt="${user.displayName}"><span>${user.displayName}</span>${hostIcon}`;
      userList.appendChild(userItem);
    });
  }

 function updatePlaylistUI({ playlist, nowPlayingIndex }) {
  const queueList = document.getElementById("queue-list");
  queueList.innerHTML = "";
  if (!playlist || playlist.length === 0) {
    queueList.innerHTML = '<p class="system-message">Playlist is empty</p>';
    return;
  }

  playlist.forEach((item, index) => {
    const queueItemDiv = document.createElement("div");
    queueItemDiv.className = "queue-item";
    queueItemDiv.dataset.index = index;

    const playIndicator = index === nowPlayingIndex ? '▶' : (index < nowPlayingIndex ? '✓' : index + 1);
    
    // Build host controls HTML string only if needed
    const hostControls = isHost ? `
      <div class="playlist-item-controls">
        <button class="delete-track-btn" title="Remove from playlist">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/>
          </svg>
        </button>
      </div>
    ` : `<span class="queue-item__duration">${formatTime(item.duration_ms)}</span>`;

    if (index === nowPlayingIndex) queueItemDiv.classList.add("is-playing");
    if (index < nowPlayingIndex) queueItemDiv.classList.add("is-played");
    if (isHost) queueItemDiv.classList.add("is-host-clickable");
    
    // Set the full innerHTML in one go
    queueItemDiv.innerHTML = `
      <span class="queue-item__number">${playIndicator}</span>
      <img src="${item.albumArt || "/placeholder.svg"}" alt="${item.name}" class="queue-item__art">
      <div class="track-info">
        <p>${item.name}</p>
        <p>${item.artist || ""}</p>
      </div>
      ${hostControls}`;

    queueList.appendChild(queueItemDiv);
  });

  // Attach event listeners after all items are in the DOM
  if (isHost) {
    queueList.querySelectorAll(".is-host-clickable").forEach((item) => {
      item.addEventListener("click", (e) => {
        // Prevent click on delete button from triggering play
        if (e.target.closest('.delete-track-btn')) return;
        
        const clickedIndex = parseInt(e.currentTarget.dataset.index, 10);
        if (clickedIndex !== nowPlayingIndex) {
          socket.emit("playTrackAtIndex", { roomId: currentRoomId, index: clickedIndex });
        }
      });
    });

    queueList.querySelectorAll(".delete-track-btn").forEach((button) => {
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        const indexToDelete = parseInt(e.currentTarget.closest(".queue-item").dataset.index, 10);
        socket.emit("deleteTrack", { roomId: currentRoomId, indexToDelete });
        showToast("Track removed from playlist.");
      });
    });
  }
}

  function updateSuggestionsUI(suggestions) {
    const suggestionsList = document.getElementById("suggestions-list");
    const suggestionsCountDisplay = document.getElementById(
      "suggestions-count-display"
    );
    suggestionsList.innerHTML = "";
    suggestionsCountDisplay.textContent = `(${suggestions.length})`;

    if (!suggestions || suggestions.length === 0) {
      suggestionsList.innerHTML =
        '<p class="system-message">No suggestions yet</p>';
      return;
    }
    suggestions.forEach((item) => {
      const suggestionDiv = document.createElement("div");
      suggestionDiv.className = "suggestion-item";
      suggestionDiv.dataset.id = item.suggestionId;
      const hostControls = isHost
        ? `<div class="suggestion-controls">
             <button class="suggestion-approve" title="Approve">
               <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
             </button>
             <button class="suggestion-reject" title="Reject">
               <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>
             </button>
           </div>`
        : "";
      suggestionDiv.innerHTML = `
        <img src="${item.albumArt || "/placeholder.svg"}" alt="${
        item.name
      }" class="queue-item__art">
        <div class="track-info">
          <p>${item.name}</p>
          <p class="suggestion-item__suggester">by ${
            item.artist
          } - suggested by ${item.suggester.name}</p>
        </div>
        ${hostControls}`;
      suggestionsList.appendChild(suggestionDiv);
    });

    if (isHost) {
      suggestionsList
        .querySelectorAll(".suggestion-approve")
        .forEach((button) => {
          button.addEventListener("click", (e) => {
            const suggestionId =
              e.currentTarget.closest(".suggestion-item").dataset.id;
            socket.emit("approveSuggestion", {
              roomId: currentRoomId,
              suggestionId,
            });
            showToast("Suggestion approved!");
          });
        });
      suggestionsList
        .querySelectorAll(".suggestion-reject")
        .forEach((button) => {
          button.addEventListener("click", (e) => {
            const suggestionId =
              e.currentTarget.closest(".suggestion-item").dataset.id;
            socket.emit("rejectSuggestion", {
              roomId: currentRoomId,
              suggestionId,
            });
            showToast("Suggestion rejected.");
          });
        });
    }
  }
});
