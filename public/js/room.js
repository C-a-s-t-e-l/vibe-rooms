// public/js/room.js (Final, Rebuilt, and Correct Version)

document.addEventListener('DOMContentLoaded', () => {
    // --- UTILITY FUNCTIONS ---
    const getInitials = (name) => {
        if (!name) return '??';
        const parts = name.split(' ');
        if (parts.length > 1) {
            return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        }
        return name.substring(0, 2).toUpperCase();
    };

    const formatTime = (ms) => {
        if (!ms || isNaN(ms)) return '0:00';
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    };

    // --- INITIALIZATION ---
    console.log('Room script loaded.');
    const socket = io();
    let currentUser;
    let currentRoomId = window.location.pathname.split('/').pop();
    let nowPlayingInterval;
    let isHost = false;
    let spotifyPlayer;
    let youtubePlayer;
    let currentTrackDuration = 0;
    let audioContextUnlocked = false;
    let currentTrackSource = null;
    let spotifyDeviceId = null;

    // --- DOM ELEMENTS (No changes) ---
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
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const volumeSlider = document.getElementById('volume-slider');
    const queueList = document.getElementById('queue-list');
    const searchForm = document.getElementById('search-form');
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');
    const linkForm = document.getElementById('link-form');
    const linkInput = document.getElementById('link-input');

    // --- ROBUST AUDIO UNLOCK ---
    const unlockAudio = () => {
        if (audioContextUnlocked) return;
        audioContextUnlocked = true;
        
        if (spotifyPlayer) {
             spotifyPlayer.resume().then(() => console.log('Playback resumed on user gesture!'));
        }
        if (youtubePlayer) {
            youtubePlayer.unMute();
            youtubePlayer.setVolume(volumeSlider.value);
             if (youtubePlayer.getPlayerState() === YT.PlayerState.CUED) {
                 youtubePlayer.playVideo();
            }
        }
        console.log("Audio unlocked by user gesture.");
    };
    
    // --- INITIALIZATION SEQUENCE ---
    const token = localStorage.getItem('spotifyAccessToken');
    if (!token) { window.location.href = '/'; return; }
    
    const spotifyApi = new SpotifyWebApi();
    spotifyApi.setAccessToken(token);
    
    window.onSpotifyWebPlaybackSDKReady = () => {
        spotifyPlayer = new Spotify.Player({
            name: 'Vibe Rooms Player',
            getOAuthToken: cb => { cb(token); }
        });

        // STEP 1: Wait for the player to be fully ready.
        spotifyPlayer.addListener('ready', ({ device_id }) => {
            console.log('Spotify Player is ready with Device ID', device_id);
            spotifyDeviceId = device_id;
            // The player is ready, now we can start the main application logic.
            initializeRoom();
        });
        
        spotifyPlayer.addListener('player_state_changed', (state) => {
            if (!state || currentTrackSource !== 'spotify') return;
            const playIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7Z"/></svg>`;
            const pauseIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M14 19h4V5h-4v14M6 19h4V5H6v14Z"/></svg>`;
            playPauseBtn.innerHTML = state.paused ? playIcon : pauseIcon;
        });

        spotifyPlayer.addListener('initialization_error', ({ message }) => { console.error('Init Error:', message); });
        spotifyPlayer.addListener('authentication_error', ({ message }) => { console.error('Auth Error:', message); });
        spotifyPlayer.addListener('account_error', ({ message }) => { console.error('Account Error:', message); });
        
        spotifyPlayer.connect();
    };

    window.onYouTubeIframeAPIReady = () => {
        youtubePlayer = new YT.Player('youtube-player', {
            height: '360', width: '640', playerVars: { 'playsinline': 1, 'controls': 0 },
            events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
        });
    };

    function onPlayerReady(event) { console.log('YouTube Player is ready.'); }

    function onPlayerStateChange(event) {
        if (currentTrackSource !== 'youtube') return;
        const playIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7Z"/></svg>`;
        const pauseIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M14 19h4V5h-4v14M6 19h4V5H6v14Z"/></svg>`;
        playPauseBtn.innerHTML = event.data === YT.PlayerState.PLAYING ? pauseIcon : playIcon;
    }

    // THIS IS THE FIX: A MASTER FUNCTION TO SET UP EVERYTHING IN ORDER
    function initializeRoom() {
        // This listener will now handle audio unlocking on first click AND after reloads.
        document.addEventListener('click', unlockAudio);
        document.addEventListener('keydown', unlockAudio);

        // STEP 2: Get user identity
        spotifyApi.getMe().then(user => {
            currentUser = user;
            
            // STEP 3: Set up all Socket.IO listeners
            setupSocketListeners();
            
            // STEP 4: Set up all UI event listeners
            setupUIEventListeners();
            
            // STEP 5: Finally, join the room
            socket.emit('joinRoom', { roomId: currentRoomId, spotifyUser: currentUser });

        }).catch(() => {
            localStorage.removeItem('spotifyAccessToken');
            window.location.href = '/';
        });
    }

    function setupSocketListeners() {
        socket.on('roomState', (data) => {
            if (!data) return;
            roomNameDisplay.textContent = data.name;
            updateQueueUI(data.queue);
            updateNowPlayingUI(data.nowPlaying);
            if (currentUser && data.host === currentUser.id) {
                isHost = true;
                hostControlsWrapper.classList.remove('is-guest');
            } else {
                isHost = false;
                hostControlsWrapper.classList.add('is-guest');
            }
        });

        socket.on('newSongPlaying', (nowPlaying) => {
            updateNowPlayingUI(nowPlaying);
            if (!nowPlaying || !nowPlaying.track) {
                if (spotifyPlayer) spotifyPlayer.pause();
                if (youtubePlayer) youtubePlayer.pauseVideo();
                return;
            }
            const { track, startTime } = nowPlaying;
            const latency = Date.now() - startTime;
            if (track.source === 'spotify') {
                if (youtubePlayer) youtubePlayer.pauseVideo();
                if (spotifyPlayer && spotifyDeviceId) {
                    spotifyPlayer._options.getOAuthToken(access_token => {
                        fetch(`https://api.spotify.com/v1/me/player/play?device_id=${spotifyDeviceId}`, {
                            method: 'PUT',
                            body: JSON.stringify({ uris: [track.uri], position_ms: latency }),
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${access_token}` },
                        }).catch(e => console.error("Error starting Spotify playback:", e));
                    });
                }
            } else if (track.source === 'youtube') {
                if (spotifyPlayer) spotifyPlayer.pause();
                if (youtubePlayer) {
                    youtubePlayer.loadVideoById({ videoId: track.id, startSeconds: Math.floor(latency / 1000) });
                    if (audioContextUnlocked) {
                        youtubePlayer.unMute();
                        youtubePlayer.setVolume(volumeSlider.value);
                        youtubePlayer.playVideo();
                    }
                }
            }
        });

        socket.on('newChatMessage', (message) => message.system ? renderSystemMessage(message.text) : renderChatMessage(message));
        socket.on('updateRoomsList', (rooms) => {
            const currentRoomData = rooms.find(r => r.id === currentRoomId);
            if (currentRoomData) listenerCountDisplay.textContent = currentRoomData.listenerCount;
        });
        socket.on('queueUpdated', updateQueueUI);
        socket.on('kicked', ({ roomName }) => {
            alert(`You have been kicked from the room "${roomName}" by the host.`);
            window.location.href = '/';
        });
    }

    // This function now correctly attaches all UI event listeners.
    function setupUIEventListeners() {
        chatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            if (chatInput.value.trim() !== '' && currentUser) {
                socket.emit('sendMessage', { 
                    roomId: currentRoomId, text: chatInput.value, 
                    user: currentUser.display_name, userId: currentUser.id
                });
                chatInput.value = '';
            }
        });
        
        searchForm.addEventListener('submit', (e) => e.preventDefault());
        searchInput.addEventListener('input', () => {
            const query = searchInput.value;
            if (query.trim() !== '') {
                searchResults.classList.add('is-visible');
                spotifyApi.searchTracks(query, { limit: 10 }).then(data => displaySearchResults(data.tracks.items));
            } else {
                searchResults.classList.remove('is-visible');
            }
        });

        linkForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const url = linkInput.value;
            if (!url.trim()) return;
            const spTrackRegex = /open\.spotify\.com\/track\/([a-zA-Z0-9]+)/;
            const spPlaylistRegex = /open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/;
            const ytRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=|embed\/|v\/|)([\w-]{11})/;
            const spTrackMatch = url.match(spTrackRegex);
            const spPlaylistMatch = url.match(spPlaylistRegex);
            const ytMatch = url.match(ytRegex);
            if (spTrackMatch && spTrackMatch[1]) {
                socket.emit('addSong', { roomId: currentRoomId, trackId: spTrackMatch[1], token });
            } else if (spPlaylistMatch && spPlaylistMatch[1]) {
                socket.emit('addPlaylist', { roomId: currentRoomId, playlistId: spPlaylistMatch[1], token });
            } else if (ytMatch && ytMatch[1]) {
                socket.emit('addYouTubeTrack', { roomId: currentRoomId, videoId: ytMatch[1] });
            } else {
                alert("Invalid Link. Please paste a valid Spotify track/playlist or YouTube video link.");
            }
            linkInput.value = '';
        });

        playPauseBtn.addEventListener('click', () => {
            if (!audioContextUnlocked) unlockAudio();
            if (currentTrackSource === 'spotify' && spotifyPlayer) spotifyPlayer.togglePlay();
            else if (currentTrackSource === 'youtube' && youtubePlayer) {
                const state = youtubePlayer.getPlayerState();
                if (state === YT.PlayerState.PLAYING) youtubePlayer.pauseVideo(); else youtubePlayer.playVideo();
            }
        });

        prevBtn.addEventListener('click', () => { if (isHost) socket.emit('seekTrack', { roomId: currentRoomId, position_ms: 0 }); });
        nextBtn.addEventListener('click', () => { if (isHost) socket.emit('skipTrack', { roomId: currentRoomId }); });
        
        volumeSlider.addEventListener('input', (e) => {
            const volume = e.target.value;
            if (spotifyPlayer) spotifyPlayer.setVolume(volume / 100);
            if (youtubePlayer) youtubePlayer.setVolume(volume);
        });
        
        document.getElementById('progress-bar-container').addEventListener('click', (e) => {
            if (!isHost || currentTrackDuration === 0) return;
            const pos = e.offsetX / e.currentTarget.clientWidth;
            socket.emit('seekTrack', { roomId: currentRoomId, position_ms: Math.floor(pos * currentTrackDuration) });
        });
        
        document.addEventListener('click', (e) => {
            const searchContainer = document.querySelector('.search-container');
            if (searchContainer && !searchContainer.contains(e.target)) {
                searchResults.classList.remove('is-visible');
            }
        });
    }

    // --- UI RENDERING FUNCTIONS (no changes from here) ---
    const renderChatMessage = (message) => {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-message';
        const initials = getInitials(message.user);
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        msgDiv.innerHTML = `
            <div class="chat-message__avatar">${initials}</div>
            <div class="chat-message__content">
                <div class="chat-message__header">
                    <span class="chat-message__username">${message.user}</span>
                    <span class="chat-message__timestamp">${timestamp}</span>
                </div>
                <p class="chat-message__text">${message.text}</p>
            </div>
        `;
        const usernameEl = msgDiv.querySelector('.chat-message__username');
        if (isHost && currentUser && currentUser.id !== message.userId) {
            usernameEl.classList.add('kickable');
            usernameEl.title = 'Click to moderate';
            usernameEl.onclick = () => { if (confirm(`Do you want to kick ${message.user} from the room?`)) socket.emit('kickUser', { roomId: currentRoomId, targetSpotifyId: message.userId }); };
        }
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    };
    const renderSystemMessage = (text) => {
        const p = document.createElement('p');
        p.className = 'system-message';
        p.textContent = text;
        chatMessages.appendChild(p);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    };
    const updateNowPlayingUI = (nowPlaying) => {
        clearInterval(nowPlayingInterval);
        currentTrackDuration = 0;
        currentTrackSource = nowPlaying ? nowPlaying.track.source : null;
        if (!nowPlaying || !nowPlaying.track) {
            nowPlayingCard.classList.remove('is-playing');
            nowPlayingArt.src = '/assets/placeholder.svg';
            nowPlayingName.textContent = 'Nothing Playing';
            nowPlayingArtist.textContent = 'Add a song to start the vibe';
            roomBackground.style.backgroundImage = 'none';
            progressBar.style.width = '0%';
            currentTimeDisplay.textContent = '0:00';
            totalTimeDisplay.textContent = '0:00';
            return;
        }
        nowPlayingCard.classList.add('is-playing');
        const track = nowPlaying.track;
        currentTrackDuration = track.duration_ms;
        nowPlayingArt.src = track.albumArt;
        nowPlayingName.textContent = track.name;
        nowPlayingArtist.textContent = track.artist;
        roomBackground.style.backgroundImage = `url('${track.albumArt}')`;
        totalTimeDisplay.textContent = formatTime(track.duration_ms);
        nowPlayingInterval = setInterval(() => {
            const elapsedTime = Date.now() - nowPlaying.startTime;
            if (elapsedTime >= track.duration_ms) {
                clearInterval(nowPlayingInterval);
                progressBar.style.width = '100%';
                return;
            }
            const progressPercent = (elapsedTime / track.duration_ms) * 100;
            progressBar.style.width = `${progressPercent}%`;
            currentTimeDisplay.textContent = formatTime(elapsedTime);
        }, 500);
    };
    const updateQueueUI = (queue) => {
        queueList.innerHTML = '';
        if (!queue || queue.length === 0) {
            queueList.innerHTML = '<p class="system-message">Queue is empty</p>';
            return;
        }
        queue.forEach((track, index) => {
            queueList.innerHTML += `
                <div class="queue-item">
                    <span class="queue-item__number">${index + 1}</span>
                    <img src="${track.albumArt}" alt="${track.name}" class="queue-item__art">
                    <div class="track-info">
                        <p>${track.name}</p>
                        <p>${track.artist}</p>
                    </div>
                    <span class="queue-item__duration">${formatTime(track.duration_ms)}</span>
                </div>
            `;
        });
    };
    const displaySearchResults = (tracks) => {
        searchResults.innerHTML = '';
        if (!tracks || tracks.length === 0) return;
        tracks.slice(0, 5).forEach(track => {
            const trackDiv = document.createElement('div');
            trackDiv.className = 'queue-item';
            trackDiv.style.cursor = 'pointer';
            const albumArtUrl = track.album.images.find(img => img.height >= 48)?.url || '/assets/placeholder.svg';
            trackDiv.innerHTML = `
                <span class="queue-item__number">
                    <svg style="width:24px;height:24px" viewBox="0 0 24 24"><path fill="currentColor" d="M19,11H13V5h-2v6H5v2h6v6h2v-6h6V11z" /></svg>
                </span>
                <img src="${albumArtUrl}" alt="${track.name}" class="queue-item__art">
                <div class="track-info">
                    <p>${track.name}</p>
                    <p>${track.artists[0].name}</p>
                </div>
                <span class="queue-item__duration">${formatTime(track.duration_ms)}</span>
            `;
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