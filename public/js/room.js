// public/js/room.js (Final, Definitive, Event-Driven Version)

document.addEventListener('DOMContentLoaded', () => {
    // --- UTILITY FUNCTIONS ---
    const getInitials = (name) => {
        if (!name) return '??';
        const parts = name.split(' ');
        return parts.length > 1 ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase() : name.substring(0, 2).toUpperCase();
    };
    const formatTime = (ms) => {
        if (!ms || isNaN(ms)) return '0:00';
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    };

    // --- STATE & INITIALIZATION ---
    const socket = io();
    let currentUser;
    let currentRoomId = window.location.pathname.split('/').pop();
    let nowPlayingInterval;
    let isHost = false, isPremium = false, audioContextUnlocked = false;
    let spotifyPlayer, spotifyDeviceId = null, currentTrackSource = null;

    // --- DOM ELEMENTS ---
    const roomBackground = document.getElementById('room-background');
    const roomNameDisplay = document.getElementById('room-name-display');
    const listenerCountDisplay = document.getElementById('listener-count-display');
    const hostControlsWrapper = document.getElementById('host-controls-wrapper');
    const chatMessages = document.getElementById('chat-messages');
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const nowPlayingCard = document.querySelector('.now-playing-card');
    const nowPlayingArt = document.getElementById('now-playing-art');
    const nowPlayingName = document.getElementById('now-playing-name');
    const nowPlayingArtist = document.getElementById('now-playing-artist');
    const currentTimeDisplay = document.getElementById('current-time');
    const totalTimeDisplay = document.getElementById('total-time');
    const progressBar = document.getElementById('progress-bar');
    const playPauseBtn = document.getElementById('play-pause-btn');
    const nextBtn = document.getElementById('next-btn');
    const volumeSlider = document.getElementById('volume-slider');
    const playbackControls = document.querySelector('.playback-controls');
    const searchForm = document.getElementById('search-form');
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');
    const linkForm = document.getElementById('link-form');
    const linkInput = document.getElementById('link-input');
    const queueList = document.getElementById('queue-list');
    const nativeAudioPlayer = document.getElementById('native-audio-player');

    // --- AUDIO PERMISSION HANDLER ---
    const grantAudioPermission = () => {
        if (audioContextUnlocked) return;
        console.log("User interaction detected. Audio permission granted for this session.");
        audioContextUnlocked = true;
        // The click handler itself will now be responsible for playing,
        // but we can try to kickstart a player that's already ready.
        if (currentTrackSource === 'youtube' && nativeAudioPlayer.readyState >= 3) nativeAudioPlayer.play();
        if (currentTrackSource === 'spotify' && isPremium) spotifyPlayer.resume();
        
        document.removeEventListener('click', grantAudioPermission);
        document.removeEventListener('keydown', grantAudioPermission);
    };
    
    const playIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7Z"/></svg>`;
    const pauseIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M14 19h4V5h-4v14M6 19h4V5H6v14Z"/></svg>`;
    
    // --- INITIALIZATION ---
    const token = localStorage.getItem('spotifyAccessToken');
    if (!token) { window.location.href = '/'; return; }
    const spotifyApi = new SpotifyWebApi();
    spotifyApi.setAccessToken(token);

    // YouTube IFrame API is not used.

    window.onSpotifyWebPlaybackSDKReady = () => {
        spotifyPlayer = new Spotify.Player({ name: 'Vibe Rooms Player', getOAuthToken: cb => { cb(token); } });
        spotifyPlayer.addListener('ready', ({ device_id }) => { isPremium = true; spotifyDeviceId = device_id; initializeRoom(); });
        spotifyPlayer.addListener('account_error', () => { isPremium = false; initializeRoom(); });
        spotifyPlayer.addListener('authentication_error', () => { localStorage.removeItem('spotifyAccessToken'); window.location.href = '/'; });
        spotifyPlayer.addListener('player_state_changed', (state) => {
            if (!state || !isPremium || currentTrackSource !== 'spotify') return;
            playPauseBtn.innerHTML = state.paused ? playIcon : pauseIcon;
            if (state.paused) {
                clearInterval(nowPlayingInterval);
            } else {
                spotifyPlayer.getCurrentState().then(s => {
                    if (s && !s.paused) startProgressTimer(Date.now() - s.position, s.duration);
                });
            }
        });
        spotifyPlayer.connect();
    };

    function initializeRoom() {
        document.addEventListener('click', grantAudioPermission);
        document.addEventListener('keydown', grantAudioPermission);
        spotifyApi.getMe().then(user => {
            currentUser = user;
            setupSocketListeners();
            setupUIEventListeners();
            socket.emit('joinRoom', { roomId: currentRoomId, spotifyUser: currentUser });
        });
    }

    function setupSocketListeners() {
        socket.on('roomState', (data) => {
            if (!data) return;
            roomNameDisplay.textContent = data.name;
            updateQueueUI(data.queue);
            updateNowPlayingUI(data.nowPlaying);
            if (data.nowPlaying) {
                 startProgressTimer(data.nowPlaying.startTime, data.nowPlaying.track.duration_ms);
            }
            isHost = currentUser && data.host === currentUser.id;
            hostControlsWrapper.classList.toggle('is-guest', !isHost);
        });

        socket.on('newSongPlaying', (nowPlaying) => {
            clearInterval(nowPlayingInterval);
            updateNowPlayingUI(nowPlaying);
            
            const source = nowPlaying?.track?.source;
            currentTrackSource = source;

            if (!nowPlaying) {
                nativeAudioPlayer.src = "";
                if (isPremium) spotifyPlayer.pause();
                return;
            }

            if (source === 'spotify') {
                nativeAudioPlayer.src = "";
                playbackControls.style.opacity = isPremium ? '1' : '0.6';
                playbackControls.style.pointerEvents = isPremium ? 'auto' : 'none';

                if (isPremium && spotifyPlayer && spotifyDeviceId) {
                    const { track, startTime } = nowPlaying;
                    fetch(`https://api.spotify.com/v1/me/player/play?device_id=${spotifyDeviceId}`, {
                        method: 'PUT',
                        body: JSON.stringify({ uris: [track.uri], position_ms: Math.max(0, Date.now() - startTime) }),
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    });
                }
            } else if (source === 'youtube') {
                if (isPremium) spotifyPlayer.pause();
                playbackControls.style.opacity = '1';
                playbackControls.style.pointerEvents = 'auto';

                const { track, startTime } = nowPlaying;

                // THE FIX: Listen for the 'canplay' event before doing anything else.
                nativeAudioPlayer.addEventListener('canplay', () => {
                    console.log('Native player can play. Setting time and starting timer.');
                    nativeAudioPlayer.currentTime = Math.max(0, (Date.now() - startTime) / 1000);
                    startProgressTimer(startTime, track.duration_ms);

                    // If we have permission, play. Otherwise, it will wait for the user to click the play button.
                    if (audioContextUnlocked) {
                        nativeAudioPlayer.play().catch(e => console.error("Autoplay was prevented:", e));
                    }
                }, { once: true }); // Use { once: true } so this only fires once per song load.

                // Now, set the source. This will trigger the 'canplay' event when ready.
                nativeAudioPlayer.src = track.url;
            }
        });
        socket.on('queueUpdated', updateQueueUI);
        socket.on('newChatMessage', (message) => message.system ? renderSystemMessage(message.text) : renderChatMessage(message));
    }

    function setupUIEventListeners() {
        playPauseBtn.addEventListener('click', () => {
            grantAudioPermission(); // First, this grants permission if it's the first click.

            if (currentTrackSource === 'spotify' && isPremium) {
                spotifyPlayer.togglePlay();
            } else if (currentTrackSource === 'youtube') {
                if (nativeAudioPlayer.paused) {
                    nativeAudioPlayer.play();
                } else {
                    nativeAudioPlayer.pause();
                }
            }
        });

        volumeSlider.addEventListener('input', (e) => {
            grantAudioPermission();
            const volume = e.target.value;
            if (isPremium) spotifyPlayer.setVolume(volume / 100);
            nativeAudioPlayer.volume = volume / 100;
        });

        nativeAudioPlayer.onplay = () => { if (currentTrackSource === 'youtube') playPauseBtn.innerHTML = pauseIcon; };
        nativeAudioPlayer.onpause = () => { if (currentTrackSource === 'youtube') playPauseBtn.innerHTML = playIcon; };
        nativeAudioPlayer.onended = () => { if (currentTrackSource === 'youtube') playPauseBtn.innerHTML = playIcon; };

        linkForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const url = linkInput.value.trim();
            if (!url) return;
            const spTrackRegex = /open\.spotify\.com\/track\/([a-zA-Z0-9]+)/;
            const spPlaylistRegex = /open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/;
            const ytRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=|embed\/|v\/|)([\w-]{11})/;
            const spTrackMatch = url.match(spTrackRegex);
            const spPlaylistMatch = url.match(spPlaylistRegex);
            const ytMatch = url.match(ytRegex);
            if (spTrackMatch) socket.emit('addSong', { roomId: currentRoomId, trackId: spTrackMatch[1], token });
            else if (spPlaylistMatch) socket.emit('addPlaylist', { roomId: currentRoomId, playlistId: spPlaylistMatch[1], token });
            else if (ytMatch && ytMatch[1]) socket.emit('addYouTubeTrack', { roomId: currentRoomId, videoId: ytMatch[1] });
            else alert("Invalid Link. Please paste a valid Spotify or YouTube link.");
            linkInput.value = '';
        });

        chatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = chatInput.value.trim();
            if (text && currentUser) {
                socket.emit('sendMessage', { roomId: currentRoomId, text, user: currentUser.display_name, userId: currentUser.id });
                chatInput.value = '';
            }
        });

        nextBtn.addEventListener('click', () => isHost && socket.emit('skipTrack', { roomId: currentRoomId }));
        
        searchForm.addEventListener('submit', e => e.preventDefault());
        searchInput.addEventListener('input', () => {
            const query = searchInput.value;
            if (query.trim()) {
                spotifyApi.searchTracks(query, { limit: 5 }).then(data => displaySearchResults(data.tracks.items));
                searchResults.classList.add('is-visible');
            } else {
                searchResults.classList.remove('is-visible');
            }
        });

        document.addEventListener('click', (e) => {
            if (!document.querySelector('.search-container').contains(e.target)) {
                searchResults.classList.remove('is-visible');
            }
        });
    }
    
    function startProgressTimer(startTime, duration_ms) {
        clearInterval(nowPlayingInterval);
        const update = () => {
            const elapsedTime = Date.now() - startTime;
            if (elapsedTime >= duration_ms) {
                clearInterval(nowPlayingInterval);
                progressBar.style.width = '100%';
                return;
            }
            progressBar.style.width = `${(elapsedTime / duration_ms) * 100}%`;
            currentTimeDisplay.textContent = formatTime(elapsedTime);
        };
        nowPlayingInterval = setInterval(update, 500);
        update();
    }
    
    function updateNowPlayingUI(nowPlaying) {
        if (!nowPlaying || !nowPlaying.track) {
            nowPlayingCard.classList.remove('is-playing');
            nowPlayingArt.src = '/assets/placeholder.svg';
            nowPlayingName.textContent = 'Nothing Playing';
            nowPlayingArtist.textContent = 'Add a song to start the vibe';
            roomBackground.style.backgroundImage = 'none';
            progressBar.style.width = '0%';
            currentTimeDisplay.textContent = '0:00';
            totalTimeDisplay.textContent = '0:00';
            playPauseBtn.innerHTML = playIcon;
            return;
        }
        const { track } = nowPlaying;
        nowPlayingCard.classList.add('is-playing');
        nowPlayingArt.src = track.albumArt;
        nowPlayingName.textContent = track.name;
        nowPlayingArtist.textContent = track.artist;
        roomBackground.style.backgroundImage = `url('${track.albumArt}')`;
        totalTimeDisplay.textContent = formatTime(track.duration_ms);
        playPauseBtn.innerHTML = playIcon; // Default to play icon until a player confirms it's playing
    };

    function renderChatMessage(message) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-message';
        msgDiv.innerHTML = `
            <div class="chat-message__avatar">${getInitials(message.user)}</div>
            <div class="chat-message__content">
                <div class="chat-message__header">
                    <span class="chat-message__username">${message.user}</span>
                    <span class="chat-message__timestamp">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <p class="chat-message__text">${message.text}</p>
            </div>`;
        const usernameEl = msgDiv.querySelector('.chat-message__username');
        if (isHost && currentUser && currentUser.id !== message.userId) {
            usernameEl.classList.add('kickable');
            usernameEl.title = 'Click to moderate';
            usernameEl.onclick = () => { if (confirm(`Do you want to kick ${message.user} from the room?`)) socket.emit('kickUser', { roomId: currentRoomId, targetSpotifyId: message.userId }); };
        }
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    };

    function renderSystemMessage(text) {
        const p = document.createElement('p');
        p.className = 'system-message'; p.textContent = text;
        chatMessages.appendChild(p);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    };
    
    function updateQueueUI(queue) {
        queueList.innerHTML = '';
        if (!queue || queue.length === 0) {
            queueList.innerHTML = '<p class="system-message">Queue is empty</p>'; return;
        }
        queue.forEach((track, index) => {
            queueList.innerHTML += `
                <div class="queue-item">
                    <span class="queue-item__number">${index + 1}</span>
                    <img src="${track.albumArt}" alt="${track.name}" class="queue-item__art">
                    <div class="track-info"><p>${track.name}</p><p>${track.artist}</p></div>
                    <span class="queue-item__duration">${formatTime(track.duration_ms)}</span>
                </div>`;
        });
    };

    function displaySearchResults(tracks) {
        searchResults.innerHTML = '';
        if (!tracks || tracks.length === 0) return;
        tracks.forEach(track => {
            const trackDiv = document.createElement('div');
            trackDiv.className = 'queue-item'; trackDiv.style.cursor = 'pointer';
            trackDiv.innerHTML = `
                <span class="queue-item__number"><svg style="width:24px;height:24px" viewBox="0 0 24 24"><path fill="currentColor" d="M19,11H13V5h-2v6H5v2h6v6h2v-6h6V11z" /></svg></span>
                <img src="${track.album.images.slice(-1)[0]?.url || '/assets/placeholder.svg'}" alt="${track.name}" class="queue-item__art">
                <div class="track-info"><p>${track.name}</p><p>${track.artists[0].name}</p></div>
                <span class="queue-item__duration">${formatTime(track.duration_ms)}</span>`;
            trackDiv.onclick = () => {
                socket.emit('addSong', { roomId: currentRoomId, trackId: track.id, token });
                searchInput.value = '';
                searchResults.innerHTML = '';
                searchResults.classList.remove('is-visible');
            };
            searchResults.appendChild(trackDiv);
        });
    };
});