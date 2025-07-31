// public/js/room.js (Final Polish: Click-outside-to-close Search)

document.addEventListener("DOMContentLoaded", () => {
  // All setup, state, and utility functions remain the same...
  const formatTime = (ms) => {
    if (!ms || isNaN(ms)) return "0:00";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
  };
const socket = io("https://vibes-fqic.onrender.com", {
  withCredentials: true,
  transports: ["websocket"],
});
  const currentRoomSlug = window.location.pathname.split("/").pop();
let currentRoomId = null;
  let nowPlayingInterval;
  let isHost = false,
    audioContextUnlocked = false,
    currentSongDuration = 0;
  let playAfterUnlock = false;
  let currentSuggestions = [];
  let currentPlaylistState = { playlist: [], nowPlayingIndex: -1 };
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
  socket.emit("joinRoom", currentRoomSlug);

  // --- SOCKET LISTENERS (No changes in this step) ---
  // --- In public/js/room.js ---

  function setupSocketListeners() {
    socket.on("roomState", (data) => {
      if (!data) {
        alert("This Vibe Room doesn't exist or has ended.");
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

      // Update all UI elements from the initial state
      currentPlaylistState = data.playlistState || {
        playlist: [],
        nowPlayingIndex: -1,
      };
      updatePlaylistUI(currentPlaylistState);
      currentSuggestions = data.suggestions || [];
      updateSuggestionsUI(currentSuggestions);
      updateUserListUI(data.userList || []); // Use the user list from roomState
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

    socket.on("playlistUpdated", (playlistState) => {
      currentPlaylistState = playlistState;
      updatePlaylistUI(playlistState);
    });

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
    socket.on("searchYouTubeResults", (results) => {
      updateSearchResultsUI(results);
    });

    // *** THE FIX: Handle dedicated updates for the user list and count ***
    socket.on("updateUserList", (users) => {
      updateUserListUI(users);
    });
    socket.on("updateListenerCount", (count) => {
      document.getElementById("listener-count-display").textContent = count;
    });
  }

  // --- UI EVENT LISTENERS ---
  function setupUIEventListeners() {
    // Playback and chat listeners are unchanged...
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

      // Optimistic UI spinner
      if (isHost) {
        addSpinnerItem(document.getElementById("queue-list"));
      } else {
        addSpinnerItem(
          document.getElementById("suggestions-list"),
          "Suggesting..."
        );
      }

      socket.emit("addYouTubeTrack", { roomId: currentRoomId, url: url });

      // *** THE CHANGE: Add toast notification ***
      showToast(isHost ? "Added to playlist!" : "Suggestion sent!");

      inputEl.value = "";
    };
    document
      .getElementById("host-link-form")
      .addEventListener("submit", handleLinkSubmit);
    document
      .getElementById("guest-link-form")
      .addEventListener("submit", handleLinkSubmit);

    const searchForm = document.getElementById("search-form");
    const searchInput = document.getElementById("search-input");
    const searchResults = document.getElementById("search-results");

    searchForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const query = searchInput.value.trim();
      if (query) {
        socket.emit("searchYouTube", { query });
        updateSearchResultsUI(null, true);
      } else {
        // If search is submitted empty, just hide results
        searchResults.style.display = "none";
      }
    });

    // *** THE FIX: Global click listener to close search results ***
    document.addEventListener("click", (e) => {
      // If the click is NOT on the search input AND NOT inside the search results container
      if (
        !searchInput.contains(e.target) &&
        !searchResults.contains(e.target)
      ) {
        searchResults.style.display = "none"; // Hide the results
      }
    });
    const tabButtons = document.querySelectorAll(".tab-btn");
    const tabContents = document.querySelectorAll(".tab-content");

    tabButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.dataset.tab;

        tabButtons.forEach((btn) => btn.classList.remove("active"));
        button.classList.add("active");

        tabContents.forEach((content) => {
          content.classList.remove("active");
          if (content.id === `${tab}-content`) {
            content.classList.add("active");
          }
        });
      });
    });
  }

  // --- PLAYER EVENT HANDLERS (Unchanged) ---
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

  // --- UI RENDERING ---

  function updateSearchResultsUI(results, isLoading = false) {
    const resultsList = document.getElementById("search-results");
    resultsList.innerHTML = "";
    resultsList.style.display = "flex";

    if (isLoading) {
      resultsList.innerHTML = '<p class="system-message">Searching...</p>';
      return;
    }

    if (!results || results.length === 0) {
      resultsList.innerHTML = '<p class="system-message">No results found</p>';
      return;
    }

    results.forEach((item) => {
      const resultDiv = document.createElement("div");
      resultDiv.className = "search-result-item";
      resultDiv.innerHTML = `<img src="${item.thumbnail}" alt="${item.title}"> <div class="track-info"> <p>${item.title}</p> <p>${item.artist}</p> </div>`;
      resultDiv.addEventListener("click", () => {
        const youtubeUrl = `https://www.youtube.com/watch?v=${item.videoId}`;

        if (isHost) {
          addSpinnerItem(document.getElementById("queue-list"));
        } else {
          addSpinnerItem(
            document.getElementById("suggestions-list"),
            "Suggesting..."
          );
        }

        socket.emit("addYouTubeTrack", {
          roomId: currentRoomId,
          url: youtubeUrl,
        });

        // *** THE CHANGE: Add toast notification ***
        showToast(isHost ? "Added to playlist!" : "Suggestion sent!");

        // Clear search
        document.getElementById("search-input").value = "";
        resultsList.innerHTML = "";
        resultsList.style.display = "none";
      });
      resultsList.appendChild(resultDiv);
    });
  }

  function showToast(message, type = "success") {
    const container = document.getElementById("toast-container");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    // Automatically remove the toast element from the DOM after the animation
    setTimeout(() => {
      toast.remove();
    }, 4000); // Should match the animation duration
  }

  function updateUserListUI(users) {
    const userList = document.getElementById("user-list");
    const userCountDisplay = document.getElementById("user-count-display");
    userList.innerHTML = "";
    userCountDisplay.textContent = `(${users.length})`;

    users.sort((a, b) => b.isHost - a.isHost); // Ensure host is always at the top

    users.forEach((user) => {
      const userItem = document.createElement("div");
      userItem.className = "user-list-item";

      const hostIcon = user.isHost ? '<span class="host-icon">👑</span>' : "";

      userItem.innerHTML = `
        <img src="${user.avatar}" alt="${user.displayName}">
        <span>${user.displayName}</span>
        ${hostIcon}
      `;
      userList.appendChild(userItem);
    });
  }

  // All other rendering functions are unchanged...
  function addSpinnerItem(listElement, text = "Loading...") {
    if (listElement.querySelector(".system-message"))
      listElement.innerHTML = "";
    const spinnerItem = document.createElement("div");
    spinnerItem.className =
      listElement.id === "queue-list" ? "queue-item" : "suggestion-item";
    spinnerItem.style.opacity = "0.6";
    spinnerItem.innerHTML = ` <span class="queue-item__number"> <svg class="spinner" viewBox="0 0 50 50"><circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5"></circle></svg> </span> <img src="/assets/placeholder.svg" alt="loading" class="queue-item__art"> <div class="track-info"> <p>${text}</p> </div> `;
    listElement.appendChild(spinnerItem);
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
      }</span> <img src="${item.albumArt || "/assets/placeholder.svg"}" alt="${
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
          if (clickedIndex !== nowPlayingIndex) {
            socket.emit("playTrackAtIndex", {
              roomId: currentRoomId,
              index: clickedIndex,
            });
          }
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
