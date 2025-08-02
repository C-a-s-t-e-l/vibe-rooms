// frontend/room.js

document.addEventListener("DOMContentLoaded", () => {
  const BACKEND_URL = "https://vibes-fqic.onrender.com";
  const userToken = localStorage.getItem("vibe_token");

  if (!userToken) {
    window.location.href = "/";
    return;
  }

  const socket = io(BACKEND_URL, { auth: { token: userToken } });

  // --> CHANGE: Global player variable for the YouTube Iframe Player
  let player;

  // --> NEW: These global functions are REQUIRED by the YouTube API
  // They must be in the global scope, so we define them here.
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
    // Set initial volume
    const volumeSlider = document.getElementById("volume-slider");
    if (player && player.setVolume) {
      player.setVolume(volumeSlider.value);
    }
  }

  function onPlayerStateChange(event) {
  // When a song ends, the host tells the server to skip to the next one.
  if (event.data === YT.PlayerState.ENDED) {
    if (isHost) socket.emit("skipTrack", { roomId: currentRoomId });
  }

  const isPlaying = event.data === YT.PlayerState.PLAYING;
  updatePlayPauseIcon(isPlaying);

  if (isPlaying) {
    // --- THIS IS THE NEW LOGIC ---
    // If we are the host and the current song's duration is 0, we need to fix it.
    if (isHost && currentPlaylistState && currentPlaylistState.playlist[currentPlaylistState.nowPlayingIndex]) {
        const currentTrack = currentPlaylistState.playlist[currentPlaylistState.nowPlayingIndex];
        if (currentTrack.duration_ms === 0) {
            // Get the real duration from the player API
            const realDurationMs = player.getDuration() * 1000;
            
            // Only send the update if the duration is valid
            if (realDurationMs > 0) {
                console.log(`Host is updating duration for track ${currentPlaylistState.nowPlayingIndex} to ${realDurationMs}ms`);
                // Send the correct duration to the server
                socket.emit("hostUpdateDuration", {
                    roomId: currentRoomId,
                    trackIndex: currentPlaylistState.nowPlayingIndex,
                    durationMs: realDurationMs
                });
                
                // Also update our local copy immediately for the progress bar
                currentTrack.duration_ms = realDurationMs;
                currentSongDuration = realDurationMs;
            }
        }
    }
    // --- END OF NEW LOGIC ---

    // Original progress timer logic remains
    const newStartTime = Date.now() - (player.getCurrentTime() * 1000);
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
  // --> DELETED: `nativeAudioPlayer` is no longer needed.

  const playIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7Z"/></svg>`;
  const pauseIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M14 19h4V5h-4v14M6 19h4V5H6v14Z"/></svg>`;

  function unlockAudio() {
    if (audioContextUnlocked) return;
    audioContextUnlocked = true;
    audioUnlockOverlay.style.display = "none";
    // --> CHANGE: We don't need to manually play here anymore. The sync logic will handle it.
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
      if (!data) {
        window.location.href = "/";
        return;
      }
      currentRoomId = data.id;
      document.title = data.name;
      isHost = data.isHost;
      const addVibeWrapper = document.getElementById("add-vibe-wrapper");
      addVibeWrapper.classList.toggle("is-host", isHost);
      addVibeWrapper.classList.toggle("is-guest", !isHost);
      document
        .getElementById("host-controls-wrapper")
        .classList.toggle("is-guest", !isHost);
      document.getElementById("room-name-display").textContent = data.name;
      currentPlaylistState = data.playlistState || {
        playlist: [],
        nowPlayingIndex: -1,
      };
      updatePlaylistUI(currentPlaylistState);
      currentSuggestions = data.suggestions || [];
      updateSuggestionsUI(currentSuggestions);
      updateUserListUI(data.userList || []);
      document.getElementById("listener-count-display").textContent =
        data.listenerCount;
      syncPlayerState(data.nowPlaying);
    });

    socket.on("newSongPlaying", (nowPlayingData) => {
      if (nowPlayingData && nowPlayingData.nowPlayingIndex !== undefined) {
        currentPlaylistState.nowPlayingIndex = nowPlayingData.nowPlayingIndex;
        updatePlaylistUI(currentPlaylistState);
      }
      syncPlayerState(nowPlayingData);
    });

    // --> CHANGE: The syncPulse logic is simplified. We trust the host's player state more.
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
      const correctedPosition = data.position + latency;
      const clientPosition = player.getCurrentTime() * 1000;
      const drift = Math.abs(correctedPosition - clientPosition);

      // Only seek if the drift is significant (e.g., more than a second)
      if (drift > 1000) {
        player.seekTo(correctedPosition / 1000, true);
      }

      // Sync play/pause state
      const playerState = player.getPlayerState();
      if (data.isPlaying && playerState !== YT.PlayerState.PLAYING) {
        player.playVideo();
      } else if (!data.isPlaying && playerState === YT.PlayerState.PLAYING) {
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

    // Unchanged listeners
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
    // --- DELETED: The 'searchYouTubeResults' listener is removed. ---
  }

  function setupUIEventListeners() {
    playPauseBtn.addEventListener("click", () => {
      // --> CHANGE: Use the Iframe Player's state
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
      // --> CHANGE: Use Iframe Player's volume control
      if (player && player.setVolume) player.setVolume(e.target.value);
    });

    document
      .getElementById("progress-bar-container")
      .addEventListener("click", (e) => {
        // --> CHANGE: Use Iframe Player's seek function
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

    const handleLinkSubmit = async (e) => { // Make the function async
  e.preventDefault();
  const inputEl = isHost ? document.getElementById("host-link-input") : document.getElementById("guest-link-input");
  const url = inputEl.value.trim();
  if (!url) return;
  inputEl.value = ""; // Clear the input immediately

  try {
    // Step 1: Frontend calls YouTube's oEmbed endpoint. This is quota-free and reliable.
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const response = await fetch(oembedUrl);

    if (!response.ok) {
        throw new Error("Could not fetch video information.");
    }

    const data = await response.json();

    // The oEmbed endpoint doesn't give us duration or videoId directly. We have to be clever.
    const videoIdMatch = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/);
    if (!videoIdMatch || !videoIdMatch[1]) {
        throw new Error("Could not parse Video ID from URL.");
    }
    const videoId = videoIdMatch[1];
    
    // We can't get duration easily, so we'll let the backend fill it in later if needed,
    // or better yet, get it from the Iframe Player API once it loads. For now, we set it to 0.

    // Step 2: Build the track object on the frontend.
    const trackData = {
      videoId: videoId,
      name: data.title,
      artist: data.author_name,
      albumArt: data.thumbnail_url,
      duration_ms: 0, // We'll handle duration later
      url: url,
      source: "youtube",
    };

    // Step 3: Send the complete track object to the server.
    socket.emit("addYouTubeTrack", { roomId: currentRoomId, trackData: trackData });
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

    // --- DELETED: All search-related event listeners are removed. ---

    // Tab switching logic (unchanged)
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

  // --> CHANGE: This function now controls the Iframe player
  function syncPlayerState(nowPlaying) {
    clearInterval(nowPlayingInterval);
    if (!nowPlaying || !nowPlaying.track) {
      updateNowPlayingUI(null, false);
      if (player && player.stopVideo) player.stopVideo();
      return;
    }

    // Ensure the player is ready before trying to control it.
    if (!player || typeof player.loadVideoById !== "function") {
      console.warn("Player not ready, will try again shortly.");
      // If the player isn't ready, we wait. The onPlayerReady event will handle playing.
      return;
    }

    updateNowPlayingUI(nowPlaying, nowPlaying.isPlaying);

    const { track, isPlaying, position, serverTimestamp } = nowPlaying;
    const latency = Date.now() - serverTimestamp;
    const correctedPosition = (position + latency) / 1000;

    // Load the new video
    player.loadVideoById(track.videoId, correctedPosition);

    // If the state is 'playing', play the video.
    if (isPlaying) {
      if (audioContextUnlocked) {
        player.playVideo();
      } else {
        // If audio is locked, we can't play yet. Show the unlock overlay.
        // The sync logic will handle playing once unlocked.
        audioUnlockOverlay.style.display = "grid";
      }
    }
  }

  // All other UI update functions (`updatePlaylistUI`, `updateNowPlayingUI`, etc.) remain largely the same
  // as they just render data, which hasn't changed structure.

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
    document
      .querySelector(".now-playing-card")
      .classList.toggle("is-playing", isPlaying);
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
  // All other helper functions below this line are included for completeness and require no changes.
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
      if (index < nowPlayingIndex) {
        queueItemDiv.classList.add("is-played");
      } else if (index === nowPlayingIndex) {
        queueItemDiv.classList.add("is-playing");
      } else {
        queueItemDiv.classList.add("is-upcoming");
      }
      if (isHost) {
        queueItemDiv.classList.add("is-host-clickable");
      }
      const hostControls = isHost
        ? ` <div class="playlist-item-controls"> <button class="delete-track-btn" title="Remove from playlist"> <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg> </button> </div> `
        : `<span class="queue-item__duration">${formatTime(
            item.duration_ms
          )}</span>`;
      queueItemDiv.innerHTML = `<span class="queue-item__number">${
        index + 1
      }</span> <img src="${item.albumArt || "/placeholder.svg"}" alt="${
        item.name
      }" class="queue-item__art"> <div class="track-info"> <p>${
        item.name
      }</p> <p>${item.artist || ""}</p> </div> ${hostControls}`;
      queueList.appendChild(queueItemDiv);
    });
    if (isHost) {
      queueList.querySelectorAll(".is-host-clickable").forEach((item) => {
        item.addEventListener("click", (e) => {
          const clickedIndex = parseInt(e.currentTarget.dataset.index, 10);
          if (clickedIndex !== nowPlayingIndex)
            socket.emit("playTrackAtIndex", {
              roomId: currentRoomId,
              index: clickedIndex,
            });
        });
      });
      queueList.querySelectorAll(".delete-track-btn").forEach((button) => {
        button.addEventListener("click", (e) => {
          e.stopPropagation();
          const indexToDelete = parseInt(
            e.currentTarget.closest(".queue-item").dataset.index,
            10
          );
          socket.emit("deleteTrack", { roomId: currentRoomId, indexToDelete });
          showToast("Track removed from playlist.");
        });
      });
    }
  }
  function updateSuggestionsUI(suggestions) {
    const suggestionsList = document.getElementById("suggestions-list");
    suggestionsList.innerHTML = "";
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
        ? ` <div class="suggestion-controls"> <button class="suggestion-approve" title="Approve"> <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg> </button> <button class="suggestion-reject" title="Reject"> <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg> </button> </div> `
        : "";
      suggestionDiv.innerHTML = ` <img src="${
        item.albumArt || "/placeholder.svg"
      }" alt="${
        item.name
      }" class="queue-item__art"> <div class="track-info"> <p>${
        item.name
      }</p> <p class="suggestion-item__suggester">Suggested by: ${
        item.suggester.name
      }</p> </div> ${hostControls} `;
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
