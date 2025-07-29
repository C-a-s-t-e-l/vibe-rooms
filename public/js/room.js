// public/js/room.js (Phase 3, Task 3.1 - Client-side with Click-to-Play)

document.addEventListener("DOMContentLoaded", () => {
  // --- UTILITY FUNCTIONS & STATE (no changes) ---
  const formatTime = (ms) => {
    if (!ms || isNaN(ms)) return "0:00";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
  };
  const socket = io();
  const currentRoomId = window.location.pathname.split("/").pop();
  let nowPlayingInterval;
  let isHost = false,
    audioContextUnlocked = false,
    currentSongDuration = 0;
  let playAfterUnlock = false;
  let currentSuggestions = [];
  let currentPlaylistState = { playlist: [], nowPlayingIndex: -1 };

  // --- DOM ELEMENTS (no changes) ---
  const audioUnlockOverlay = document.getElementById("audio-unlock-overlay");
  const playPauseBtn = document.getElementById("play-pause-btn");
  const nativeAudioPlayer = document.getElementById("native-audio-player");
  const playIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7Z"/></svg>`;
  const pauseIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M14 19h4V5h-4v14M6 19h4V5H6v14Z"/></svg>`;

  function unlockAudio() {
    if (audioContextUnlocked) return;
    audioContextUnlocked = true;
    audioUnlockOverlay.style.display = "none";
    if (playAfterUnlock) {
      nativeAudioPlayer
        .play()
        .catch((e) => console.error("Autoplay after unlock failed:", e));
      playAfterUnlock = false;
    }
  }
  audioUnlockOverlay.addEventListener("click", unlockAudio);

  setupSocketListeners();
  setupUIEventListeners();
  socket.emit("joinRoom", currentRoomId);

  // --- SOCKET LISTENERS ---
  function setupSocketListeners() {
    socket.on("roomState", (data) => {
      if (!data) {
        alert("This Vibe Room doesn't exist or has ended.");
        window.location.href = "/";
        return;
      }
      isHost = data.isHost;
      const addVibeWrapper = document.getElementById("add-vibe-wrapper");
      addVibeWrapper.classList.toggle("is-host", isHost);
      addVibeWrapper.classList.toggle("is-guest", !isHost);
      document
        .getElementById("host-controls-wrapper")
        .classList.toggle("is-guest", !isHost);
      document.getElementById("room-name-display").textContent = data.name;

      // Update with the new playlist structure
      currentPlaylistState = data.playlistState || {
        playlist: [],
        nowPlayingIndex: -1,
      };
      updatePlaylistUI(currentPlaylistState);

      currentSuggestions = data.suggestions || [];
      updateSuggestionsUI(currentSuggestions);

      syncPlayerState(data.nowPlaying);
    });

    socket.on("newSongPlaying", (nowPlayingData) => {
      // When a new song plays, we also get the new index
      if (nowPlayingData) {
        currentPlaylistState.nowPlayingIndex = nowPlayingData.nowPlayingIndex;
        updatePlaylistUI(currentPlaylistState);
      }
      syncPlayerState(nowPlayingData);
    });

    // NEW: Listen for playlist updates
    socket.on("playlistUpdated", (playlistState) => {
      currentPlaylistState = playlistState;
      updatePlaylistUI(playlistState);
    });

    // All other socket listeners are unchanged...
    socket.on("syncPulse", (data) => {
      if (isHost || !data || !data.track) return;
      updatePlayPauseIcon(data.isPlaying);
      const latency = Date.now() - data.serverTimestamp;
      const correctedPosition = data.position + latency;
      const clientPosition = nativeAudioPlayer.currentTime * 1000;
      const drift = Math.abs(correctedPosition - clientPosition);
      if (drift > 350) {
        nativeAudioPlayer.currentTime = correctedPosition / 1000;
        if (data.isPlaying) {
          startProgressTimer(
            Date.now() - correctedPosition,
            data.track.duration_ms
          );
        }
      }
      if (data.isPlaying && nativeAudioPlayer.paused) {
        nativeAudioPlayer
          .play()
          .catch((e) => console.error("Sync play failed", e));
      } else if (!data.isPlaying && !nativeAudioPlayer.paused) {
        nativeAudioPlayer.pause();
      }
    });
    socket.on("hostAssigned", () => {
      isHost = true;
      const addVibeWrapper = document.getElementById("add-vibe-wrapper");
      addVibeWrapper.classList.add("is-host");
      addVibeWrapper.classList.remove("is-guest");
      document
        .getElementById("host-controls-wrapper")
        .classList.remove("is-guest");
      renderSystemMessage("👑 You are now the host of this room!");
      updatePlaylistUI(currentPlaylistState);
      updateSuggestionsUI(currentSuggestions);
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
  }

  // --- UI EVENT LISTENERS ---
  function setupUIEventListeners() {
    playPauseBtn.addEventListener("click", () => {
      if (!isHost || !nativeAudioPlayer.src) return;
      const newIsPlayingState = nativeAudioPlayer.paused;
      socket.emit("hostPlaybackChange", {
        roomId: currentRoomId,
        isPlaying: newIsPlayingState,
      });
      if (newIsPlayingState) nativeAudioPlayer.play();
      else nativeAudioPlayer.pause();
    });

    // MODIFIED: Use the correct event names
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

    // All other UI event listeners are unchanged...
    document.getElementById("volume-slider").addEventListener("input", (e) => {
      nativeAudioPlayer.volume = e.target.value / 100;
    });
    document
      .getElementById("progress-bar-container")
      .addEventListener("click", (e) => {
        if (!isHost || !currentSongDuration) return;
        const bar = document.getElementById("progress-bar-container");
        const seekRatio = e.offsetX / bar.clientWidth;
        const seekTimeMs = currentSongDuration * seekRatio;
        nativeAudioPlayer.currentTime = seekTimeMs / 1000;
        if (nativeAudioPlayer.paused) nativeAudioPlayer.play();
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
    const handleLinkSubmit = (e) => {
      e.preventDefault();
      const inputEl = isHost
        ? document.getElementById("host-link-input")
        : document.getElementById("guest-link-input");
      const url = inputEl.value.trim();
      if (!url) return;
      const ytRegex =
        /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=|embed\/|v\/|)([\w-]{11})/;
      const ytMatch = url.match(ytRegex);
      if (ytMatch && ytMatch[1]) {
        if (isHost) {
          const queueList = document.getElementById("queue-list");
          if (queueList.querySelector(".system-message"))
            queueList.innerHTML = "";
          addSpinnerItem(queueList);
        } else {
          const suggestionsList = document.getElementById("suggestions-list");
          if (suggestionsList.querySelector(".system-message"))
            suggestionsList.innerHTML = "";
          addSpinnerItem(suggestionsList, "Suggesting...");
        }
        socket.emit("addYouTubeTrack", {
          roomId: currentRoomId,
          videoId: ytMatch[1],
        });
        inputEl.value = "";
      } else {
        alert("Invalid Link. Please paste a valid YouTube link.");
      }
    };
    document
      .getElementById("host-link-form")
      .addEventListener("submit", handleLinkSubmit);
    document
      .getElementById("guest-link-form")
      .addEventListener("submit", handleLinkSubmit);
  }

  // --- PLAYER EVENT HANDLERS (no changes) ---
  nativeAudioPlayer.onplay = () => {
    updatePlayPauseIcon(true);
    const newStartTime = Date.now() - nativeAudioPlayer.currentTime * 1000;
    startProgressTimer(newStartTime, currentSongDuration);
  };
  nativeAudioPlayer.onpause = () => {
    updatePlayPauseIcon(false);
    clearInterval(nowPlayingInterval);
  };
  nativeAudioPlayer.onended = () => {
    updatePlayPauseIcon(false);
    clearInterval(nowPlayingInterval);
    if (isHost) socket.emit("skipTrack", { roomId: currentRoomId });
  };

  // --- CORE LOGIC & UI RENDERING ---

  // REPLACED `updateQueueUI` with the smarter `updatePlaylistUI`
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

      // Add the data-index for the click-to-play feature
      queueItemDiv.dataset.index = index;

      // Add classes based on the song's state
      if (index < nowPlayingIndex) {
        queueItemDiv.classList.add("is-played");
      } else if (index === nowPlayingIndex) {
        queueItemDiv.classList.add("is-playing");
      } else {
        queueItemDiv.classList.add("is-upcoming");
      }

      // Make items clickable for the host
      if (isHost) {
        queueItemDiv.classList.add("is-host-clickable");
      }

      queueItemDiv.innerHTML = `
            <span class="queue-item__number">${index + 1}</span>
            <img src="${item.albumArt || "/assets/placeholder.svg"}" alt="${
        item.name
      }" class="queue-item__art">
            <div class="track-info">
                <p>${item.name}</p>
                <p>${item.artist || ""}</p>
            </div>
            <span class="queue-item__duration">${formatTime(
              item.duration_ms
            )}</span>
        `;
      queueList.appendChild(queueItemDiv);
    });

    // Add click listener for the "click-to-play" feature
    if (isHost) {
      queueList.querySelectorAll(".is-host-clickable").forEach((item) => {
        item.addEventListener("click", (e) => {
          const clickedIndex = parseInt(e.currentTarget.dataset.index, 10);
          // Prevent playing the same song again if it's already playing
          if (clickedIndex !== nowPlayingIndex) {
            socket.emit("playTrackAtIndex", {
              roomId: currentRoomId,
              index: clickedIndex,
            });
          }
        });
      });
    }
  }

  // All other rendering functions are unchanged...
  function addSpinnerItem(listElement, text = "Loading...") {
    const spinnerItem = document.createElement("div");
    spinnerItem.className =
      listElement.id === "queue-list" ? "queue-item" : "suggestion-item";
    spinnerItem.style.opacity = "0.6";
    spinnerItem.innerHTML = ` <span class="queue-item__number"> <svg class="spinner" viewBox="0 0 50 50"><circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5"></circle></svg> </span> <img src="/assets/placeholder.svg" alt="loading" class="queue-item__art"> <div class="track-info"> <p>${text}</p> </div> `;
    listElement.appendChild(spinnerItem);
  }
  function syncPlayerState(nowPlaying) {
    clearInterval(nowPlayingInterval);
    playAfterUnlock = false;
    if (!nowPlaying || !nowPlaying.track) {
      updateNowPlayingUI(null, false);
      nativeAudioPlayer.src = "";
      return;
    }
    const { track, isPlaying, position, serverTimestamp } = nowPlaying;
    updateNowPlayingUI(nowPlaying, isPlaying);
    if (nativeAudioPlayer.src !== track.url) {
      nativeAudioPlayer.src = track.url;
    }
    nativeAudioPlayer.onloadedmetadata = () => {
      const latency = Date.now() - serverTimestamp;
      const correctedPosition = position + latency;
      const targetPositionMs = Math.min(correctedPosition, track.duration_ms);
      nativeAudioPlayer.currentTime = targetPositionMs / 1000;
      if (isPlaying) {
        if (audioContextUnlocked) {
          nativeAudioPlayer
            .play()
            .catch((e) => console.error("Autoplay prevented:", e));
        } else {
          playAfterUnlock = true;
          audioUnlockOverlay.style.display = "grid";
        }
      }
    };
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
    const cardEl = document.querySelector(".now-playing-card");
    if (!nowPlaying || !nowPlaying.track) {
      cardEl.classList.remove("is-playing");
      artEl.src = "/assets/placeholder.svg";
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
    cardEl.classList.add("is-playing");
    artEl.src = track.albumArt || "/assets/placeholder.svg";
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
        item.albumArt || "/assets/placeholder.svg"
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
          });
        });
    }
  }
});
