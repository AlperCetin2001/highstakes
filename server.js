/* UNO PRO SERVER - Stabil Bağlantılı */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// CORS ayarları
app.use(cors({
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
}));

// Static files
app.use(express.static(__dirname));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy',
        server: 'UNO PRO',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Main route
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

const server = http.createServer(app);

// Socket.IO configuration
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 30000,
    pingInterval: 10000,
    maxHttpBufferSize: 1e6,
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000, // 2 dakika
        skipMiddlewares: true
    }
});

// --- GAME LOGIC ---
const CARD_VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
const COLORS = ['red', 'blue', 'green', 'yellow'];

class GameRoom {
    constructor(id, settings = {}) {
        this.id = id;
        this.players = [];
        this.deck = [];
        this.discardPile = [];
        this.turnIndex = 0;
        this.direction = 1;
        this.gameState = 'LOBBY';
        this.settings = {
            stacking: settings.stacking || false,
            targetScore: 500
        };
        this.pendingChallenge = null;
        this.unoCallers = new Set();
        this.drawStack = 0;
        this.creationTime = Date.now();
        this.maxPlayers = 4;
        this.roomName = settings.roomName || `Oda ${id}`;
        this.password = settings.password || null;
        this.isPublic = settings.isPublic !== false;
        this.lastActivity = Date.now();
        this.reconnections = new Map(); // Yeniden bağlanan oyuncular
    }

    createDeck() {
        this.deck = [];
        
        COLORS.forEach(color => {
            // 1 adet 0
            this.deck.push({ 
                color, 
                value: '0', 
                type: 'number', 
                id: Math.random().toString(36).substr(2, 9),
                points: 0
            });
            
            // 2 adet 1-9
            for (let v of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
                for (let i = 0; i < 2; i++) {
                    this.deck.push({ 
                        color, 
                        value: v, 
                        type: 'number', 
                        id: Math.random().toString(36).substr(2, 9),
                        points: parseInt(v)
                    });
                }
            }
            
            // 2 adet aksiyon kartları
            for (let v of ['skip', 'reverse', 'draw2']) {
                for (let i = 0; i < 2; i++) {
                    this.deck.push({ 
                        color, 
                        value: v, 
                        type: 'action', 
                        id: Math.random().toString(36).substr(2, 9),
                        points: 20
                    });
                }
            }
        });
        
        // 4 Joker, 4 Joker+4
        for (let i = 0; i < 4; i++) {
            this.deck.push({ 
                color: 'black', 
                value: 'wild', 
                type: 'wild', 
                id: Math.random().toString(36).substr(2, 9),
                points: 50
            });
            this.deck.push({ 
                color: 'black', 
                value: 'draw4', 
                type: 'wild', 
                id: Math.random().toString(36).substr(2, 9),
                points: 50
            });
        }
        
        this.shuffle();
    }

    shuffle() {
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
    }

    draw(count) {
        const cards = [];
        for (let i = 0; i < count; i++) {
            if (this.deck.length === 0) {
                if (this.discardPile.length > 1) {
                    const top = this.discardPile.pop();
                    this.deck = this.discardPile;
                    this.discardPile = [top];
                    this.shuffle();
                } else {
                    this.createDeck();
                }
            }
            if (this.deck.length > 0) {
                cards.push(this.deck.pop());
            }
        }
        return cards;
    }

    assignPositions() {
        const positions = ['bottom', 'right', 'top', 'left'];
        this.players.forEach((player, index) => {
            player.position = positions[index];
            player.seat = index;
        });
    }

    canStart() {
        return this.players.length >= 2 && this.players.length <= this.maxPlayers;
    }

    // Oyuncu yeniden bağlandığında
    reconnectPlayer(oldSocketId, newSocketId) {
        const player = this.players.find(p => p.id === oldSocketId);
        if (player) {
            player.id = newSocketId;
            this.reconnections.set(oldSocketId, newSocketId);
            return player;
        }
        return null;
    }
}

const rooms = {};
const playerRooms = {}; // socket.id -> roomId mapping

// Oda temizleme (5 dakikada bir)
setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(roomId => {
        const room = rooms[roomId];
        if (room.players.length === 0 && now - room.lastActivity > 5 * 60 * 1000) {
            delete rooms[roomId];
            console.log(`🗑️ Boş oda temizlendi: ${roomId}`);
        }
    });
}, 5 * 60 * 1000);

io.on('connection', (socket) => {
    console.log('🔗 Yeni bağlantı:', socket.id);
    
    // Session recovery
    const previousId = socket.handshake.auth.sessionId;
    if (previousId) {
        console.log('🔄 Session recovery attempt:', previousId);
    }
    
    // Send welcome
    socket.emit('welcome', { 
        message: 'UNO PRO Sunucusuna Hoşgeldiniz',
        serverTime: Date.now(),
        serverVersion: '2.0'
    });

    // --- LOBİ İŞLEMLERİ ---
    socket.on('getRooms', () => {
        try {
            const list = Object.values(rooms)
                .filter(r => r.gameState === 'LOBBY' && r.isPublic)
                .map(r => ({ 
                    id: r.id, 
                    name: r.roomName,
                    playerCount: r.players.length, 
                    maxPlayers: r.maxPlayers,
                    settings: r.settings,
                    hasPassword: !!r.password,
                    createdAgo: Math.floor((Date.now() - r.creationTime) / 1000)
                }))
                .sort((a, b) => b.createdAgo - a.createdAgo);
            
            socket.emit('roomList', list);
        } catch (error) {
            console.error('Oda listesi hatası:', error);
            socket.emit('roomList', []);
        }
    });

    socket.on('createRoom', ({ nickname, avatar, settings, roomName, password }, callback) => {
        try {
            console.log('🏗️ Oda oluşturma isteği:', { nickname, roomName });
            
            // Validate nickname
            if (!nickname || nickname.trim().length < 2) {
                if (callback) callback({ success: false, error: 'Geçerli bir isim girin (en az 2 karakter)' });
                return;
            }
            
            // Generate room ID
            const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
            
            // Create room
            const room = new GameRoom(roomId, { 
                ...settings, 
                roomName: roomName || `${nickname}'in Odası`,
                password: password || null
            });
            
            // Add player
            room.players.push({ 
                id: socket.id, 
                nickname: nickname.substring(0, 20), 
                avatar: avatar || '👤', 
                hand: [], 
                score: 0, 
                isHost: true,
                isReady: true,
                joinedAt: Date.now()
            });
            
            rooms[roomId] = room;
            playerRooms[socket.id] = roomId;
            
            socket.join(roomId);
            
            // Assign positions
            room.assignPositions();
            room.lastActivity = Date.now();
            
            // Send success response
            if (callback) {
                callback({ 
                    success: true, 
                    roomId, 
                    message: 'Oda başarıyla oluşturuldu!' 
                });
            }
            
            // Update room
            io.to(roomId).emit('roomUpdate', { 
                players: room.players.map(p => ({
                    id: p.id,
                    nickname: p.nickname,
                    avatar: p.avatar,
                    score: p.score,
                    isHost: p.isHost,
                    isReady: p.isReady,
                    position: p.position,
                    seat: p.seat
                })), 
                roomId, 
                settings: room.settings,
                roomName: room.roomName,
                canStart: room.canStart()
            });
            
            // Update room list
            io.emit('roomList', Object.values(rooms)
                .filter(r => r.gameState === 'LOBBY' && r.isPublic)
                .map(r => ({ 
                    id: r.id, 
                    name: r.roomName,
                    playerCount: r.players.length,
                    maxPlayers: r.maxPlayers,
                    hasPassword: !!r.password
                }))
            );
            
            console.log(`✅ Oda oluşturuldu: ${roomId} - ${nickname}`);
            
        } catch (error) {
            console.error('❌ Oda oluşturma hatası:', error);
            if (callback) callback({ success: false, error: 'Oda oluşturulamadı' });
        }
    });

    socket.on('joinRoom', ({ roomId, nickname, avatar, password }, callback) => {
        try {
            console.log('🚪 Odaya katılma isteği:', { roomId, nickname });
            
            const room = rooms[roomId];
            if (!room) {
                if (callback) callback({ success: false, error: 'Oda bulunamadı!' });
                return;
            }
            
            if (room.gameState !== 'LOBBY') {
                if (callback) callback({ success: false, error: 'Oyun çoktan başladı!' });
                return;
            }
            
            if (room.players.length >= room.maxPlayers) {
                if (callback) callback({ success: false, error: 'Oda dolu!' });
                return;
            }
            
            if (room.password && room.password !== password) {
                if (callback) callback({ success: false, error: 'Yanlış şifre!' });
                return;
            }
            
            // Check duplicate nickname
            const existingPlayer = room.players.find(p => p.nickname === nickname);
            if (existingPlayer) {
                if (callback) callback({ success: false, error: 'Bu isim zaten kullanılıyor!' });
                return;
            }
            
            // Add player
            room.players.push({ 
                id: socket.id, 
                nickname: nickname.substring(0, 20), 
                avatar: avatar || '👤', 
                hand: [], 
                score: 0, 
                isHost: false,
                isReady: false,
                joinedAt: Date.now()
            });
            
            playerRooms[socket.id] = roomId;
            socket.join(roomId);
            
            room.assignPositions();
            room.lastActivity = Date.now();
            
            // Send success response
            if (callback) {
                callback({ 
                    success: true, 
                    message: 'Odaya katıldınız!' 
                });
            }
            
            // Update room
            io.to(roomId).emit('roomUpdate', { 
                players: room.players.map(p => ({
                    id: p.id,
                    nickname: p.nickname,
                    avatar: p.avatar,
                    score: p.score,
                    isHost: p.isHost,
                    isReady: p.isReady,
                    position: p.position,
                    seat: p.seat
                })), 
                roomId, 
                settings: room.settings,
                roomName: room.roomName,
                canStart: room.canStart()
            });
            
            // Notification
            socket.to(roomId).emit('notification', {
                type: 'info',
                text: `${nickname} odaya katıldı!`
            });
            
            // Update room list
            io.emit('roomList', Object.values(rooms)
                .filter(r => r.gameState === 'LOBBY' && r.isPublic)
                .map(r => ({ 
                    id: r.id, 
                    name: r.roomName,
                    playerCount: r.players.length,
                    maxPlayers: r.maxPlayers,
                    hasPassword: !!r.password
                }))
            );
            
            console.log(`✅ Odaya katıldı: ${roomId} - ${nickname}`);
            
        } catch (error) {
            console.error('❌ Odaya katılma hatası:', error);
            if (callback) callback({ success: false, error: 'Odaya katılamadınız' });
        }
    });

    socket.on('leaveRoom', () => {
        try {
            const roomId = playerRooms[socket.id];
            if (!roomId || !rooms[roomId]) return;
            
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            
            if (playerIndex !== -1) {
                const player = room.players[playerIndex];
                
                // Remove player
                room.players.splice(playerIndex, 1);
                socket.leave(roomId);
                delete playerRooms[socket.id];
                
                // Clean up empty room
                if (room.players.length === 0) {
                    delete rooms[roomId];
                    console.log(`🗑️ Boş oda kaldırıldı: ${roomId}`);
                } else {
                    // Assign new host if needed
                    if (player.isHost && room.players.length > 0) {
                        room.players[0].isHost = true;
                    }
                    
                    room.assignPositions();
                    room.lastActivity = Date.now();
                    
                    // Update room
                    io.to(roomId).emit('roomUpdate', {
                        players: room.players.map(p => ({
                            id: p.id,
                            nickname: p.nickname,
                            avatar: p.avatar,
                            score: p.score,
                            isHost: p.isHost,
                            isReady: p.isReady,
                            position: p.position,
                            seat: p.seat
                        })),
                        roomId,
                        settings: room.settings,
                        roomName: room.roomName,
                        canStart: room.canStart()
                    });
                    
                    // Notification
                    io.to(roomId).emit('notification', {
                        type: 'warning',
                        text: `${player.nickname} ayrıldı!`
                    });
                }
                
                // Update room list
                io.emit('roomList', Object.values(rooms)
                    .filter(r => r.gameState === 'LOBBY' && r.isPublic)
                    .map(r => ({ 
                        id: r.id, 
                        name: r.roomName,
                        playerCount: r.players.length,
                        maxPlayers: r.maxPlayers,
                        hasPassword: !!r.password
                    }))
                );
                
                console.log(`👋 Oyuncu ayrıldı: ${player.nickname} - ${roomId}`);
            }
        } catch (error) {
            console.error('❌ Odayı terk etme hatası:', error);
        }
    });

    socket.on('readyToggle', ({ isReady }) => {
        try {
            const roomId = playerRooms[socket.id];
            if (!roomId || !rooms[roomId]) return;
            
            const room = rooms[roomId];
            const player = room.players.find(p => p.id === socket.id);
            
            if (player) {
                player.isReady = isReady;
                room.lastActivity = Date.now();
                
                io.to(roomId).emit('roomUpdate', {
                    players: room.players.map(p => ({
                        id: p.id,
                        nickname: p.nickname,
                        avatar: p.avatar,
                        score: p.score,
                        isHost: p.isHost,
                        isReady: p.isReady,
                        position: p.position,
                        seat: p.seat
                    })),
                    roomId,
                    settings: room.settings,
                    roomName: room.roomName,
                    canStart: room.canStart()
                });
            }
        } catch (error) {
            console.error('❌ Ready toggle hatası:', error);
        }
    });

    socket.on('startGame', () => {
        try {
            const roomId = playerRooms[socket.id];
            if (!roomId || !rooms[roomId]) return;
            
            const room = rooms[roomId];
            const player = room.players.find(p => p.id === socket.id);
            
            // Only host can start and need at least 2 players
            if (!player || !player.isHost || !room.canStart()) {
                socket.emit('notification', {
                    type: 'error',
                    text: 'Oyun başlatılamıyor!'
                });
                return;
            }
            
            // Start game
            room.gameState = 'PLAYING';
            room.createDeck();
            room.unoCallers.clear();
            room.drawStack = 0;
            
            // Deal cards
            room.players.forEach(p => {
                p.hand = room.draw(7);
                p.isUno = false;
            });

            // First card
            let firstCard = null;
            do {
                if (room.deck.length === 0) {
                    room.createDeck();
                }
                firstCard = room.draw(1)[0];
                if (firstCard.color !== 'black') break;
                room.deck.push(firstCard);
                room.shuffle();
            } while (true);
            
            room.discardPile.push(firstCard);

            // First card effects
            if (firstCard.value === 'draw2') {
                const nextPlayer = getNextPlayerIndex(room);
                room.players[nextPlayer].hand.push(...room.draw(2));
            } else if (firstCard.value === 'reverse') {
                room.direction *= -1;
                if (room.players.length === 2) {
                    room.turnIndex = 1; // Skip in 2-player game
                }
            } else if (firstCard.value === 'skip') {
                room.turnIndex = 1;
            }

            // Notify game started
            io.to(roomId).emit('gameStarted', {
                initialCard: firstCard,
                players: room.players.map(p => ({
                    id: p.id,
                    nickname: p.nickname,
                    avatar: p.avatar,
                    cardCount: p.hand.length,
                    position: p.position,
                    seat: p.seat
                }))
            });
            
            // Send first game state
            updateGameState(roomId);
            
            console.log(`🎮 Oyun başladı: ${roomId}`);
            
        } catch (error) {
            console.error('❌ Oyun başlatma hatası:', error);
        }
    });

    // ... Kalan oyun kodları (playCard, drawCard, callUno, respondChallenge vb.) ...
    // Bu kısımlar önceki server.js'deki gibi kalacak

    // Disconnect handling
    socket.on('disconnect', (reason) => {
        console.log(`🔌 Bağlantı kesildi: ${socket.id} - Sebep: ${reason}`);
        
        const roomId = playerRooms[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            const player = room.players.find(p => p.id === socket.id);
            
            if (player) {
                if (room.gameState === 'PLAYING') {
                    // Game in progress - mark as disconnected
                    player.disconnected = true;
                    player.lastSeen = Date.now();
                    
                    // Notify other players
                    socket.to(roomId).emit('notification', {
                        type: 'warning',
                        text: `${player.nickname} bağlantısı koptu...`
                    });
                    
                    // Update game state
                    updateGameState(roomId);
                    
                } else {
                    // In lobby - remove player
                    room.players = room.players.filter(p => p.id !== socket.id);
                    
                    if (room.players.length === 0) {
                        delete rooms[roomId];
                    } else {
                        if (player.isHost && room.players.length > 0) {
                            room.players[0].isHost = true;
                        }
                        
                        room.assignPositions();
                        room.lastActivity = Date.now();
                        
                        io.to(roomId).emit('roomUpdate', {
                            players: room.players.map(p => ({
                                id: p.id,
                                nickname: p.nickname,
                                avatar: p.avatar,
                                score: p.score,
                                isHost: p.isHost,
                                isReady: p.isReady,
                                position: p.position,
                                seat: p.seat
                            })),
                            roomId,
                            settings: room.settings,
                            roomName: room.roomName,
                            canStart: room.canStart()
                        });
                    }
                    
                    // Update room list
                    io.emit('roomList', Object.values(rooms)
                        .filter(r => r.gameState === 'LOBBY' && r.isPublic)
                        .map(r => ({ 
                            id: r.id, 
                            name: r.roomName,
                            playerCount: r.players.length,
                            maxPlayers: r.maxPlayers,
                            hasPassword: !!r.password
                        }))
                    );
                }
            }
            
            delete playerRooms[socket.id];
        }
    });

    // Reconnect handling
    socket.on('reconnectAttempt', () => {
        console.log(`🔄 Yeniden bağlanma denemesi: ${socket.id}`);
    });

    // Helper functions
    function getNextPlayerIndex(room) {
        return (room.turnIndex + room.direction + room.players.length) % room.players.length;
    }

    function updateGameState(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        
        room.players.forEach((p, i) => {
            io.to(p.id).emit('gameState', {
                hand: p.hand,
                topCard: room.discardPile[room.discardPile.length - 1],
                isMyTurn: i === room.turnIndex && room.gameState === 'PLAYING',
                turnIndex: room.turnIndex,
                gameState: room.gameState,
                direction: room.direction,
                challengeData: room.pendingChallenge,
                players: room.players.map(pl => ({ 
                    id: pl.id, 
                    nickname: pl.nickname, 
                    avatar: pl.avatar, 
                    cardCount: pl.hand.length,
                    score: pl.score,
                    position: pl.position,
                    seat: pl.seat,
                    isUno: room.unoCallers.has(pl.id),
                    isHost: pl.isHost,
                    disconnected: pl.disconnected || false
                }))
            });
        });
    }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 UNO PRO SERVER çalışıyor - Port: ${PORT}`);
    console.log(`⏰ Server Time: ${new Date().toISOString()}`);
    console.log(`📊 Başlangıçta ${Object.keys(rooms).length} oda var`);
});
