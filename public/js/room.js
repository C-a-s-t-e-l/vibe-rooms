// public/js/room.js (Final, Architecturally Correct Version)

document.addEventListener("DOMContentLoaded", () => {
  // --- UTILITY FUNCTIONS ---
  const getInitials = (name) => {
    if (!name) return "??";
    const parts = name.split(" ");
    return parts.length > 1
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : name.substring(0, 2).toUpperCase();
  };
  const formatTime = (ms) => {
    if (!ms || isNaN(ms)) return "0:00";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
  };

  // --- STATE & INITIALIZATION ---
  const socket = io();
  let currentUser;
  let currentRoomId = window.location.pathname.split("/").pop();
  let nowPlayingInterval;
  let isHost = false;
  let spotifyPlayer;
  let youtubePlayer;
  let audioContextUnlocked = false; // The single most important flag for audio.
  let spotifyDeviceId = null;
  let isPremium = false;
  let currentTrackSource = null;

  // --- DOM ELEMENTS ---
  const roomBackground = document.getElementById("room-background");
  const roomNameDisplay = document.getElementById("room-name-display");
  const listenerCountDisplay = document.getElementById(
    "listener-count-display"
  );
  const hostControlsWrapper = document.getElementById("host-controls-wrapper");
  const chatMessages = document.getElementById("chat-messages");
  const chatForm = document.getElementById("chat-form");
  const chatInput = document.getElementById("chat-input");
  const nowPlayingCard = document.querySelector(".now-playing-card");
  const nowPlayingArt = document.getElementById("now-playing-art");
  const nowPlayingName = document.getElementById("now-playing-name");
  const nowPlayingArtist = document.getElementById("now-playing-artist");
  const currentTimeDisplay = document.getElementById("current-time");
  const totalTimeDisplay = document.getElementById("total-time");
  const progressBar = document.getElementById("progress-bar");
  const playPauseBtn = document.getElementById("play-pause-btn");
  const nextBtn = document.getElementById("next-btn");
  const volumeSlider = document.getElementById("volume-slider");
  const playbackControls = document.querySelector(".playback-controls");
  const searchForm = document.getElementById("search-form");
  const searchInput = document.getElementById("search-input");
  const searchResults = document.getElementById("search-results");
  const linkForm = document.getElementById("link-form");
  const linkInput = document.getElementById("link-input");
  const queueList = document.getElementById("queue-list");

  // --- AUDIO PERMISSION HANDLER (SIMPLIFIED AND CORRECTED) ---
  const grantAudioPermission = () => {
    if (audioContextUnlocked) return;
    console.log(
      "User interaction detected. Audio permission granted for this session."
    );
    audioContextUnlocked = true; // This function's ONLY job is to set this flag.

    // After granting permission, check if a player is waiting and needs a nudge.
    // This is especially for Spotify on reload.
    if (currentTrackSource === "spotify" && isPremium) {
      spotifyPlayer.resume();
    }

    // This listener has done its job and can be removed.
    document.removeEventListener("click", grantAudioPermission);
    document.removeEventListener("keydown", grantAudioPermission);
  };

  // --- YOUTUBE PLAYER EVENT HANDLER ---
  function onPlayerStateChange(event) {
    if (currentTrackSource !== "youtube") return;

    // When the video is ready, we make sure it's unmuted and at the correct volume.
    // We do NOT try to play it here, as that causes race conditions.
    if (event.data === YT.PlayerState.CUED) {
      youtubePlayer.unMute();
      youtubePlayer.setVolume(volumeSlider.value);
    }

    // Update the UI icon based on the player's actual state
    const playIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7Z"/></svg>`;
    const pauseIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M14 19h4V5h-4v14M6 19h4V5H6v14Z"/></svg>`;
    playPauseBtn.innerHTML =
      event.data === YT.PlayerState.PLAYING ? pauseIcon : playIcon;
  }

  // --- INITIALIZATION SEQUENCE ---
  const token = localStorage.getItem("spotifyAccessToken");
  if (!token) {
    window.location.href = "/";
    return;
  }

  const spotifyApi = new SpotifyWebApi();
  spotifyApi.setAccessToken(token);

  window.onYouTubeIframeAPIReady = () => {
    youtubePlayer = new YT.Player("youtube-player", {
      height: "0",
      width: "0",
      playerVars: { playsinline: 1, controls: 0, disablekb: 1 },
      events: {
        onReady: () => console.log("YouTube Player API is ready."),
        onStateChange: onPlayerStateChange,
      },
    });
  };

  window.onSpotifyWebPlaybackSDKReady = () => {
    spotifyPlayer = new Spotify.Player({
      name: "Vibe Rooms Player",
      getOAuthToken: (cb) => {
        cb(token);
      },
    });
    spotifyPlayer.addListener("ready", ({ device_id }) => {
      isPremium = true;
      spotifyDeviceId = device_id;
      initializeRoom();
    });
    spotifyPlayer.addListener("account_error", () => {
      isPremium = false;
      initializeRoom();
    });
    spotifyPlayer.addListener("authentication_error", () => {
      localStorage.removeItem("spotifyAccessToken");
      window.location.href = "/";
    });
    spotifyPlayer.addListener("player_state_changed", (state) => {
      if (!state || !isPremium || currentTrackSource !== "spotify") return;
      const playIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7Z"/></svg>`;
      const pauseIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M14 19h4V5h-4v14M6 19h4V5H6v14Z"/></svg>`;
      playPauseBtn.innerHTML = state.paused ? playIcon : pauseIcon;
    });
    spotifyPlayer.connect();
  };

  function initializeRoom() {
    // These listeners capture the FIRST user gesture to grant audio permission.
    document.addEventListener("click", grantAudioPermission);
    document.addEventListener("keydown", grantAudioPermission);

    spotifyApi
      .getMe()
      .then((user) => {
        currentUser = user;
        setupSocketListeners();
        setupUIEventListeners();
        socket.emit("joinRoom", {
          roomId: currentRoomId,
          spotifyUser: currentUser,
        });
      })
      .catch(() => {
        localStorage.removeItem("spotifyAccessToken");
        window.location.href = "/";
      });
  }

  function setupSocketListeners() {
    socket.on("roomState", (data) => {
      if (!data) return;
      roomNameDisplay.textContent = data.name;
      updateQueueUI(data.queue);
      updateNowPlayingUI(data.nowPlaying, false);
      isHost = currentUser && data.host === currentUser.id;
      hostControlsWrapper.classList.toggle("is-guest", !isHost);
    });

    socket.on("newSongPlaying", (nowPlaying) => {
      updateNowPlayingUI(nowPlaying, true);
      const source = nowPlaying?.track?.source;
      currentTrackSource = source;

      if (source === "spotify") {
        if (youtubePlayer) youtubePlayer.stopVideo(); // Use stopVideo to be more definitive
        playbackControls.style.opacity = isPremium ? "1" : "0.6";
        playbackControls.style.pointerEvents = isPremium ? "auto" : "none";
        if (isPremium && spotifyPlayer && spotifyDeviceId) {
          const { track, startTime } = nowPlaying;
          spotifyPlayer.resume(); // Ensure player is active
          fetch(
            `https://api.spotify.com/v1/me/player/play?device_id=${spotifyDeviceId}`,
            {
              method: "PUT",
              body: JSON.stringify({
                uris: [track.uri],
                position_ms: Math.max(0, Date.now() - startTime),
              }),
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
            }
          );
        }
      } else if (source === "youtube") {
        if (isPremium && spotifyPlayer) spotifyPlayer.pause();
        playbackControls.style.opacity = "1";
        playbackControls.style.pointerEvents = "auto";
        if (youtubePlayer) {
          const { track, startTime } = nowPlaying;
          // This just loads the video. It does not play it. Playback is handled by user action.
          youtubePlayer.loadVideoById({
            videoId: track.id,
            startSeconds: Math.max(0, (Date.now() - startTime) / 1000),
          });
        }
      }
    });
    socket.on("queueUpdated", updateQueueUI);
    socket.on("newChatMessage", (message) =>
      message.system
        ? renderSystemMessage(message.text)
        : renderChatMessage(message)
    );
  }

  function setupUIEventListeners() {
    playPauseBtn.addEventListener("click", () => {
      grantAudioPermission(); // Step 1: Grant permission if not already granted.

      // Step 2: Directly command the correct player. This is now a direct user action.
      if (currentTrackSource === "spotify" && isPremium) {
        spotifyPlayer.togglePlay();
      } else if (currentTrackSource === "youtube" && youtubePlayer) {
        const state = youtubePlayer.getPlayerState();
        if (state === YT.PlayerState.PLAYING) {
          youtubePlayer.pauseVideo();
        } else {
          // This command is inside a click handler, so it will be allowed to play with sound.
          youtubePlayer.playVideo();
        }
      }
    });
    volumeSlider.addEventListener("input", (e) => {
      grantAudioPermission(); // Also grant permission on volume change
      const volume = e.target.value;
      if (currentTrackSource === "spotify" && isPremium)
        spotifyPlayer.setVolume(volume / 100);
      else if (currentTrackSource === "youtube" && youtubePlayer)
        youtubePlayer.setVolume(volume);
    });
    linkForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const url = linkInput.value.trim();
      if (!url) return;
      const spTrackRegex = /open\.spotify\.com\/track\/([a-zA-Z0-9]+)/;
      const spPlaylistRegex = /open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/;
      const ytRegex =
        /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=|embed\/|v\/|)([\w-]{11})/;
      const spTrackMatch = url.match(spTrackRegex);
      const spPlaylistMatch = url.match(spPlaylistRegex);
      const ytMatch = url.match(ytRegex);
      if (spTrackMatch)
        socket.emit("addSong", {
          roomId: currentRoomId,
          trackId: spTrackMatch[1],
          token,
        });
      else if (spPlaylistMatch)
        socket.emit("addPlaylist", {
          roomId: currentRoomId,
          playlistId: spPlaylistMatch[1],
          token,
        });
      else if (ytMatch && ytMatch[1])
        socket.emit("addYouTubeTrack", {
          roomId: currentRoomId,
          videoId: ytMatch[1],
        });
      else alert("Invalid Link. Please paste a valid Spotify or YouTube link.");
      linkInput.value = "";
    });
    chatForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (text && currentUser) {
        socket.emit("sendMessage", {
          roomId: currentRoomId,
          text,
          user: currentUser.display_name,
          userId: currentUser.id,
        });
        chatInput.value = "";
      }
    });
    nextBtn.addEventListener(
      "click",
      () => isHost && socket.emit("skipTrack", { roomId: currentRoomId })
    );
    searchForm.addEventListener("submit", (e) => e.preventDefault());
    searchInput.addEventListener("input", () => {
      const query = searchInput.value;
      if (query.trim()) {
        spotifyApi
          .searchTracks(query, { limit: 5 })
          .then((data) => displaySearchResults(data.tracks.items));
        searchResults.classList.add("is-visible");
      } else {
        searchResults.classList.remove("is-visible");
      }
    });
    document.addEventListener("click", (e) => {
      if (!document.querySelector(".search-container").contains(e.target)) {
        searchResults.classList.remove("is-visible");
      }
    });
  }

  // --- UI RENDERING FUNCTIONS ---
  function updateNowPlayingUI(nowPlaying, startTimer = true) {
    clearInterval(nowPlayingInterval);
    if (!nowPlaying || !nowPlaying.track) {
      nowPlayingCard.classList.remove("is-playing");
      nowPlayingArt.src = "/assets/placeholder.svg";
      nowPlayingName.textContent = "Nothing Playing";
      nowPlayingArtist.textContent = "Add a song to start the vibe";
      roomBackground.style.backgroundImage = "none";
      progressBar.style.width = "0%";
      currentTimeDisplay.textContent = "0:00";
      totalTimeDisplay.textContent = "0:00";
      return;
    }
    const { track, startTime } = nowPlaying;
    nowPlayingCard.classList.add("is-playing");
    nowPlayingArt.src = track.albumArt;
    nowPlayingName.textContent = track.name;
    nowPlayingArtist.textContent = track.artist;
    roomBackground.style.backgroundImage = `url('${track.albumArt}')`;
    totalTimeDisplay.textContent = formatTime(track.duration_ms);
    if (startTimer) {
      const updateProgress = () => {
        const elapsedTime = Date.now() - startTime;
        if (elapsedTime >= track.duration_ms) {
          clearInterval(nowPlayingInterval);
          progressBar.style.width = "100%";
          return;
        }
        progressBar.style.width = `${(elapsedTime / track.duration_ms) * 100}%`;
        currentTimeDisplay.textContent = formatTime(elapsedTime);
      };
      updateProgress();
      nowPlayingInterval = setInterval(updateProgress, 500);
    }
  }
  function renderChatMessage(message) {
    const msgDiv = document.createElement("div");
    msgDiv.className = "chat-message";
    msgDiv.innerHTML = `
            <div class="chat-message__avatar">${getInitials(message.user)}</div>
            <div class="chat-message__content">
                <div class="chat-message__header">
                    <span class="chat-message__username">${message.user}</span>
                    <span class="chat-message__timestamp">${new Date().toLocaleTimeString(
                      [],
                      { hour: "2-digit", minute: "2-digit" }
                    )}</span>
                </div>
                <p class="chat-message__text">${message.text}</p>
            </div>`;
    const usernameEl = msgDiv.querySelector(".chat-message__username");
    if (isHost && currentUser && currentUser.id !== message.userId) {
      usernameEl.classList.add("kickable");
      usernameEl.title = "Click to moderate";
      usernameEl.onclick = () => {
        if (confirm(`Do you want to kick ${message.user} from the room?`))
          socket.emit("kickUser", {
            roomId: currentRoomId,
            targetSpotifyId: message.userId,
          });
      };
    }
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  function renderSystemMessage(text) {
    const p = document.createElement("p");
    p.className = "system-message";
    p.textContent = text;
    chatMessages.appendChild(p);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  function updateQueueUI(queue) {
    queueList.innerHTML = "";
    if (!queue || queue.length === 0) {
      queueList.innerHTML = '<p class="system-message">Queue is empty</p>';
      return;
    }
    queue.forEach((track, index) => {
      queueList.innerHTML += `
                <div class="queue-item">
                    <span class="queue-item__number">${index + 1}</span>
                    <img src="${track.albumArt}" alt="${
        track.name
      }" class="queue-item__art">
                    <div class="track-info"><p>${track.name}</p><p>${
        track.artist
      }</p></div>
                    <span class="queue-item__duration">${formatTime(
                      track.duration_ms
                    )}</span>
                </div>`;
    });
  }
  function displaySearchResults(tracks) {
    searchResults.innerHTML = "";
    if (!tracks || tracks.length === 0) return;
    tracks.forEach((track) => {
      const trackDiv = document.createElement("div");
      trackDiv.className = "queue-item";
      trackDiv.style.cursor = "pointer";
      trackDiv.innerHTML = `
                <span class="queue-item__number"><svg style="width:24px;height:24px" viewBox="0 0 24 24"><path fill="currentColor" d="M19,11H13V5h-2v6H5v2h6v6h2v-6h6V11z" /></svg></span>
                <img src="${
                  track.album.images.slice(-1)[0]?.url ||
                  "/assets/placeholder.svg"
                }" alt="${track.name}" class="queue-item__art">
                <div class="track-info"><p>${track.name}</p><p>${
        track.artists[0].name
      }</p></div>
                <span class="queue-item__duration">${formatTime(
                  track.duration_ms
                )}</span>`;
      trackDiv.onclick = () => {
        socket.emit("addSong", {
          roomId: currentRoomId,
          trackId: track.id,
          token,
        });
        searchInput.value = "";
        searchResults.innerHTML = "";
        searchResults.classList.remove("is-visible");
      };
      searchResults.appendChild(trackDiv);
    });
  }
});
