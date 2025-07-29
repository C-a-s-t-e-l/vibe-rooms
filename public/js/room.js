// public/js/room.js (Definitive Final Version with Sync Pulse Correction)

document.addEventListener("DOMContentLoaded", () => {
  // --- UTILITY FUNCTIONS ---
  const formatTime = (ms) => {
    if (!ms || isNaN(ms)) return "0:00";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
  };

  // --- STATE & INITIALIZATION ---
  const socket = io();
  const currentRoomId = window.location.pathname.split("/").pop();
  let nowPlayingInterval;
  let isHost = false,
    audioContextUnlocked = false,
    currentSongDuration = 0;
  let playAfterUnlock = false;

  // --- DOM ELEMENTS ---
  const audioUnlockOverlay = document.getElementById("audio-unlock-overlay");
  const playPauseBtn = document.getElementById("play-pause-btn");
  const nativeAudioPlayer = document.getElementById("native-audio-player");
  const playIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7Z"/></svg>`;
  const pauseIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M14 19h4V5h-4v14M6 19h4V5H6v14Z"/></svg>`;

  // --- AUDIO UNLOCK LOGIC ---
  function unlockAudio() {
    if (audioContextUnlocked) return;
    audioContextUnlocked = true;
    audioUnlockOverlay.style.display = "none";
    console.log("Audio unlocked by user interaction.");
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
      document
        .getElementById("host-controls-wrapper")
        .classList.toggle("is-guest", !isHost);
      document.getElementById("room-name-display").textContent = data.name;
      updateQueueUI(data.queue);
      syncPlayerState(data.nowPlaying);
    });

    socket.on("newSongPlaying", (nowPlayingData) => {
      syncPlayerState(nowPlayingData);
    });

    // In public/js/room.js

socket.on('syncPulse', (data) => {
    if (isHost || !data || !data.track) return;

    updatePlayPauseIcon(data.isPlaying);

    if (data.isPlaying) {
        // THE FIX: Calculate latency and apply it here too.
        const latency = Date.now() - data.serverTimestamp;
        const serverPosition = data.position + latency;
        const clientPosition = nativeAudioPlayer.currentTime * 1000;
        const drift = Math.abs(serverPosition - clientPosition);

        // We can now use a much tighter threshold because our calculation is more accurate.
        if (drift > 250) { 
            console.log(`Syncing! Drift was ${Math.round(drift)}ms. Correcting.`);
            nativeAudioPlayer.currentTime = serverPosition / 1000;
        }
        
        if (nativeAudioPlayer.paused) nativeAudioPlayer.play();
    } else {
        if (!nativeAudioPlayer.paused) nativeAudioPlayer.pause();
        // For paused state, we trust the server's last known position directly.
        nativeAudioPlayer.currentTime = data.position / 1000;
    }
});

    socket.on("hostAssigned", () => {
      isHost = true;
      document
        .getElementById("host-controls-wrapper")
        .classList.remove("is-guest");
      renderSystemMessage("👑 You are now the host of this room!");
    });
    socket.on("queueUpdated", updateQueueUI);
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
      const isCurrentlyPlaying = !nativeAudioPlayer.paused;
      socket.emit("hostPlaybackChange", {
        roomId: currentRoomId,
        isPlaying: !isCurrentlyPlaying,
      });
      if (isCurrentlyPlaying) nativeAudioPlayer.pause();
      else nativeAudioPlayer.play();
    });
    document
      .getElementById("next-btn")
      .addEventListener(
        "click",
        () => isHost && socket.emit("skipTrack", { roomId: currentRoomId })
      );
    document.getElementById("volume-slider").addEventListener("input", (e) => {
      nativeAudioPlayer.volume = e.target.value / 100;
    });
    document
      .getElementById("progress-bar-container")
      .addEventListener("click", (e) => {
        if (!isHost || !nativeAudioPlayer.src) return;
        const barWidth = document.getElementById(
          "progress-bar-container"
        ).clientWidth;
        const clickPosition = e.offsetX;
        const seekRatio = clickPosition / barWidth;
        const seekTimeMs = currentSongDuration * seekRatio;
        nativeAudioPlayer.currentTime = seekTimeMs / 1000;
        socket.emit("hostPlaybackChange", {
          roomId: currentRoomId,
          isPlaying: !nativeAudioPlayer.paused,
          position: seekTimeMs,
        });
      });
    document.getElementById("link-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const url = document.getElementById("link-input").value.trim();
      if (!url) return;
      const ytRegex =
        /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=|embed\/|v\/|)([\w-]{11})/;
      const ytMatch = url.match(ytRegex);
      if (ytMatch && ytMatch[1]) {
        socket.emit("addYouTubeTrack", {
          roomId: currentRoomId,
          videoId: ytMatch[1],
        });
        document.getElementById("link-input").value = "";
      } else {
        alert("Invalid Link. Please paste a valid YouTube link.");
      }
    });
    document.getElementById("chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const text = document.getElementById("chat-input").value.trim();
      if (text) {
        socket.emit("sendMessage", { roomId: currentRoomId, text });
        document.getElementById("chat-input").value = "";
      }
    });
  }

  // --- PLAYER EVENT HANDLERS ---
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

  // --- CORE LOGIC ---
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
    
    // Wait for the track to be ready to play
    nativeAudioPlayer.onloadedmetadata = () => {
        // THE FIX: Calculate latency and apply it.
        const latency = Date.now() - serverTimestamp;
        const correctedPosition = position + latency;
        
        // Ensure we don't seek past the end of the song.
        const targetPositionMs = Math.min(correctedPosition, track.duration_ms);
        nativeAudioPlayer.currentTime = targetPositionMs / 1000;
        
        if (isPlaying) {
            if (audioContextUnlocked) {
                nativeAudioPlayer.play().catch(e => console.error("Autoplay prevented:", e));
            } else {
                playAfterUnlock = true;
                audioUnlockOverlay.style.display = 'grid';
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
    if (!nowPlaying || !nowPlaying.track) {
      document
        .querySelector(".now-playing-card")
        .classList.remove("is-playing");
      artEl.src = "/assets/placeholder.svg";
      nameEl.textContent = "Nothing Playing";
      artistEl.textContent = "Add a YouTube link to start the vibe";
      bgEl.style.backgroundImage = "none";
      document.getElementById("progress-bar").style.width = "0%";
      document.getElementById("current-time").textContent = "0:00";
      totalTimeEl.textContent = "0:00";
      return;
    }
    const { track } = nowPlaying;
    currentSongDuration = track.duration_ms;
    document.querySelector(".now-playing-card").classList.add("is-playing");
    artEl.src = track.albumArt || "/assets/placeholder.svg";
    nameEl.textContent = track.name;
    artistEl.textContent = track.artist;
    bgEl.style.backgroundImage = `url('${track.albumArt}')`;
    totalTimeEl.textContent = formatTime(track.duration_ms);
  }
  function updatePlayPauseIcon(isPlaying) {
    playPauseBtn.innerHTML = isPlaying ? pauseIcon : playIcon;
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
  function updateQueueUI(queue) {
    const queueList = document.getElementById("queue-list");
    queueList.innerHTML = "";
    if (!queue || queue.length === 0) {
      queueList.innerHTML = '<p class="system-message">Queue is empty</p>';
      return;
    }
    queue.forEach((item, index) => {
      const isProcessing = item.status === "processing";
      const imageUrl = isProcessing
        ? "/assets/placeholder.svg"
        : item.albumArt || "/assets/placeholder.svg";
      const queueItemDiv = document.createElement("div");
      queueItemDiv.className = "queue-item";
      if (isProcessing) {
        queueItemDiv.style.opacity = "0.6";
      }
      queueItemDiv.innerHTML = `<span class="queue-item__number">${
        isProcessing
          ? '<svg class="spinner" viewBox="0 0 50 50"><circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5"></circle></svg>'
          : index + 1
      }</span><img src="${imageUrl}" alt="${
        item.name
      }" class="queue-item__art"><div class="track-info"><p>${
        item.name
      }</p><p>${
        item.artist || ""
      }</p></div><span class="queue-item__duration">${
        isProcessing ? "" : formatTime(item.duration_ms)
      }</span>`;
      queueList.appendChild(queueItemDiv);
    });
  }
});
