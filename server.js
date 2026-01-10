const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Use CORS for Express
app.use(cors());

// Serve static files
app.use(express.static('.'));

// Game state
const rooms = new Map();
const players = new Map();

// Helper functions
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function createDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const numbers = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    const actions = ['skip', 'reverse', 'draw-two'];
    const wilds = ['wild', 'wild-draw-four'];
    
    const deck = [];
    
    colors.forEach(color => {
        deck.push({ color, value: '0', type: 'number' });
        
        numbers.slice(1).forEach(value => {
            deck.push({ color, value, type: 'number' });
            deck.push({ color, value, type: 'number' });
        });
        
        actions.forEach(type => {
            deck.push({ color, value: type, type });
            deck.push({ color, value: type, type });
        });
    });
    
    wilds.forEach(type => {
        for (let i = 0; i < 4; i++) {
            deck.push({ color: 'black', value: type, type });
        }
    });
    
    return shuffleArray(deck);
}

function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function dealCards(deck, numPlayers) {
    const hands = [];
    for (let i = 0; i < numPlayers; i++) {
        hands.push(deck.splice(0, 7));
    }
    return hands;
}

// Socket.io events
io.on('connection', (socket) => {
    console.log('🔗 Yeni bağlantı:', socket.id);
    
    // Store player data
    players.set(socket.id, {
        socketId: socket.id,
        roomId: null,
        nickname: 'Anonim',
        avatar: '👤',
        score: 0,
        isReady: false,
        isHost: false
    });
    
    // Welcome message
    socket.emit('welcome', {
        message: 'UNO PRO Sunucusuna Hoş Geldin!',
        rooms: Array.from(rooms.values()).map(room => ({
            id: room.id,
            name: room.name,
            playerCount: room.players.length,
            maxPlayers: 4,
            hasPassword: !!room.password
        }))
    });
    
    // Get rooms
    socket.on('getRooms', () => {
        const roomList = Array.from(rooms.values()).map(room => ({
            id: room.id,
            name: room.name,
            playerCount: room.players.length,
            maxPlayers: 4,
            hasPassword: !!room.password
        }));
        socket.emit('roomList', roomList);
    });
    
    // Create room
    socket.on('createRoom', (data, callback) => {
        const player = players.get(socket.id);
        if (!player) {
            callback({ success: false, error: 'Oyuncu bulunamadı' });
            return;
        }
        
        const roomId = generateRoomCode();
        const room = {
            id: roomId,
            name: data.roomName || `${data.nickname}'in Odası`,
            password: data.password || null,
            players: [],
            settings: data.settings || {},
            gameState: 'LOBBY',
            deck: [],
            discardPile: [],
            currentPlayerIndex: 0,
            direction: 1,
            created: new Date()
        };
        
        // Update player
        player.nickname = data.nickname || 'Anonim';
        player.avatar = data.avatar || '👤';
        player.roomId = roomId;
        player.isHost = true;
        player.isReady = false;
        player.score = 0;
        
        // Add player to room
        room.players.push({
            id: socket.id,
            nickname: player.nickname,
            avatar: player.avatar,
            score: 0,
            isHost: true,
            isReady: false,
            isCurrentTurn: false,
            cardCount: 0,
            hasUno: false
        });
        
        rooms.set(roomId, room);
        
        // Join socket room
        socket.join(roomId);
        
        console.log(`🏗️ Oda oluşturuldu: ${roomId} - ${room.name}`);
        
        // Send room update
        socket.emit('roomUpdate', {
            roomId,
            roomName: room.name,
            players: room.players,
            settings: room.settings,
            canStart: false
        });
        
        // Notify all players in the room
        io.to(roomId).emit('playerJoined', {
            player: {
                id: socket.id,
                nickname: player.nickname,
                avatar: player.avatar
            },
            players: room.players
        });
        
        callback({ success: true, roomId, message: 'Oda oluşturuldu!' });
    });
    
    // Join room
    socket.on('joinRoom', (data, callback) => {
        const player = players.get(socket.id);
        if (!player) {
            callback({ success: false, error: 'Oyuncu bulunamadı' });
            return;
        }
        
        const room = rooms.get(data.roomId);
        if (!room) {
            callback({ success: false, error: 'Oda bulunamadı' });
            return;
        }
        
        if (room.players.length >= 4) {
            callback({ success: false, error: 'Oda dolu' });
            return;
        }
        
        if (room.password && room.password !== data.password) {
            callback({ success: false, error: 'Şifre yanlış' });
            return;
        }
        
        if (room.gameState !== 'LOBBY') {
            callback({ success: false, error: 'Oyun başlamış' });
            return;
        }
        
        // Update player
        player.nickname = data.nickname || 'Anonim';
        player.avatar = data.avatar || '👤';
        player.roomId = room.id;
        player.isHost = false;
        player.isReady = false;
        player.score = 0;
        
        // Add player to room
        room.players.push({
            id: socket.id,
            nickname: player.nickname,
            avatar: player.avatar,
            score: 0,
            isHost: false,
            isReady: false,
            isCurrentTurn: false,
            cardCount: 0,
            hasUno: false
        });
        
        // Join socket room
        socket.join(room.id);
        
        console.log(`🚪 Oyuncu katıldı: ${player.nickname} -> ${room.id}`);
        
        // Send room update to the joining player
        socket.emit('roomUpdate', {
            roomId: room.id,
            roomName: room.name,
            players: room.players,
            settings: room.settings,
            canStart: room.players.length >= 2 && room.players.every(p => p.isReady)
        });
        
        // Notify all players in the room
        io.to(room.id).emit('playerJoined', {
            player: {
                id: socket.id,
                nickname: player.nickname,
                avatar: player.avatar
            },
            players: room.players
        });
        
        callback({ success: true, message: 'Odaya katıldınız!' });
    });
    
    // Toggle ready
    socket.on('toggleReady', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.roomId) return;
        
        const room = rooms.get(player.roomId);
        if (!room) return;
        
        const roomPlayer = room.players.find(p => p.id === socket.id);
        if (roomPlayer) {
            roomPlayer.isReady = data.isReady;
            player.isReady = data.isReady;
            
            // Notify all players
            io.to(room.id).emit('playerReady', {
                playerId: socket.id,
                isReady: data.isReady,
                players: room.players
            });
            
            // Check if can start
            const canStart = room.players.length >= 2 && room.players.every(p => p.isReady);
            
            // Notify host
            const host = room.players.find(p => p.isHost);
            if (host) {
                io.to(host.id).emit('roomUpdate', {
                    roomId: room.id,
                    roomName: room.name,
                    players: room.players,
                    settings: room.settings,
                    canStart
                });
            }
        }
    });
    
    // Start game
    socket.on('startGame', () => {
        const player = players.get(socket.id);
        if (!player || !player.roomId) return;
        
        const room = rooms.get(player.roomId);
        if (!room || room.gameState !== 'LOBBY') return;
        
        // Check if player is host
        if (!player.isHost) return;
        
        // Check if enough players and all ready
        if (room.players.length < 2 || !room.players.every(p => p.isReady)) return;
        
        console.log(`🎮 Oyun başlatılıyor: ${room.id}`);
        
        // Initialize game
        room.gameState = 'PLAYING';
        room.deck = createDeck();
        room.discardPile = [];
        room.currentPlayerIndex = 0;
        room.direction = 1;
        
        // Shuffle and deal cards
        room.deck = shuffleArray(room.deck);
        const hands = dealCards(room.deck, room.players.length);
        
        // Assign cards to players
        room.players.forEach((player, index) => {
            player.hand = hands[index];
            player.cardCount = player.hand.length;
            player.hasUno = false;
            player.isCurrentTurn = index === 0;
        });
        
        // Draw first card (must not be wild)
        let firstCard;
        do {
            firstCard = room.deck.pop();
        } while (firstCard.color === 'black');
        
        room.topCard = firstCard;
        room.discardPile.push(firstCard);
        
        // Send game started to all players
        io.to(room.id).emit('gameStarted', {
            roomId: room.id,
            players: room.players.map(p => ({
                id: p.id,
                nickname: p.nickname,
                avatar: p.avatar,
                score: p.score,
                isHost: p.isHost,
                isReady: p.isReady,
                isCurrentTurn: p.isCurrentTurn,
                cardCount: p.cardCount,
                hasUno: p.hasUno
            }))
        });
        
        // Send initial game state to each player
        room.players.forEach((player, index) => {
            const playerSocket = io.sockets.sockets.get(player.id);
            if (playerSocket) {
                playerSocket.emit('gameState', {
                    hand: player.hand,
                    topCard: room.topCard,
                    isMyTurn: player.isCurrentTurn,
                    gameState: 'PLAYING',
                    players: room.players.map(p => ({
                        id: p.id,
                        nickname: p.nickname,
                        avatar: p.avatar,
                        score: p.score,
                        isHost: p.isHost,
                        isReady: p.isReady,
                        isCurrentTurn: p.isCurrentTurn,
                        cardCount: p.cardCount,
                        hasUno: p.hasUno
                    }))
                });
            }
        });
    });
    
    // Play card
    socket.on('playCard', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.roomId) return;
        
        const room = rooms.get(player.roomId);
        if (!room || room.gameState !== 'PLAYING') return;
        
        const roomPlayer = room.players.find(p => p.id === socket.id);
        if (!roomPlayer || !roomPlayer.isCurrentTurn) return;
        
        // Validate card index
        if (data.cardIndex >= roomPlayer.hand.length) return;
        
        const card = roomPlayer.hand[data.cardIndex];
        
        // Validate card play
        if (!isValidPlay(card, room.topCard)) {
            socket.emit('notification', { text: 'Bu kartı oynayamazsın!', type: 'warning' });
            return;
        }
        
        // Remove card from hand
        roomPlayer.hand.splice(data.cardIndex, 1);
        roomPlayer.cardCount = roomPlayer.hand.length;
        
        // Update UNO status
        if (roomPlayer.cardCount === 1 && !roomPlayer.hasUno) {
            roomPlayer.hasUno = false; // Player didn't call UNO
            // Apply penalty
            roomPlayer.hand.push(room.deck.pop());
            roomPlayer.cardCount = roomPlayer.hand.length;
            socket.emit('notification', { text: 'UNO demedin! +1 kart cezası', type: 'error' });
        } else if (roomPlayer.cardCount === 0) {
            // Player wins!
            handlePlayerWin(room, roomPlayer);
            return;
        }
        
        // Set chosen color for wild cards
        if (card.color === 'black' && data.chosenColor) {
            card.displayColor = data.chosenColor;
        }
        
        // Set as top card
        room.topCard = card;
        room.discardPile.push(card);
        
        // Handle special cards
        handleSpecialCard(room, card);
        
        // Move to next player
        moveToNextPlayer(room);
        
        // Update all players
        updateGameState(room);
        
        // Notify about the played card
        io.to(room.id).emit('notification', {
            text: `${roomPlayer.nickname} ${getCardDisplay(card)} oynadı!`,
            type: 'info'
        });
    });
    
    // Draw card
    socket.on('drawCard', () => {
        const player = players.get(socket.id);
        if (!player || !player.roomId) return;
        
        const room = rooms.get(player.roomId);
        if (!room || room.gameState !== 'PLAYING') return;
        
        const roomPlayer = room.players.find(p => p.id === socket.id);
        if (!roomPlayer || !roomPlayer.isCurrentTurn) return;
        
        // Draw card
        if (room.deck.length === 0) {
            // Reshuffle discard pile
            const topCard = room.discardPile.pop();
            room.deck = shuffleArray(room.discardPile);
            room.discardPile = [topCard];
            room.topCard = topCard;
            
            io.to(room.id).emit('notification', {
                text: 'Kartlar karıştırılıyor...',
                type: 'info'
            });
        }
        
        const drawnCard = room.deck.pop();
        roomPlayer.hand.push(drawnCard);
        roomPlayer.cardCount = roomPlayer.hand.length;
        
        // Check if player can play the drawn card
        if (isValidPlay(drawnCard, room.topCard)) {
            socket.emit('notification', {
                text: `Çektiğin kartı oynayabilirsin: ${getCardDisplay(drawnCard)}`,
                type: 'info'
            });
            // Player can choose to play or pass
        } else {
            // Move to next player
            moveToNextPlayer(room);
        }
        
        // Update game state
        updateGameState(room);
        
        socket.emit('notification', {
            text: 'Kart çektin!',
            type: 'info'
        });
    });
    
    // Pass turn
    socket.on('passTurn', () => {
        const player = players.get(socket.id);
        if (!player || !player.roomId) return;
        
        const room = rooms.get(player.roomId);
        if (!room || room.gameState !== 'PLAYING') return;
        
        const roomPlayer = room.players.find(p => p.id === socket.id);
        if (!roomPlayer || !roomPlayer.isCurrentTurn) return;
        
        // Move to next player
        moveToNextPlayer(room);
        
        // Update game state
        updateGameState(room);
        
        socket.emit('notification', {
            text: 'Pas geçtin!',
            type: 'info'
        });
    });
    
    // Call UNO
    socket.on('callUno', () => {
        const player = players.get(socket.id);
        if (!player || !player.roomId) return;
        
        const room = rooms.get(player.roomId);
        if (!room || room.gameState !== 'PLAYING') return;
        
        const roomPlayer = room.players.find(p => p.id === socket.id);
        if (!roomPlayer) return;
        
        if (roomPlayer.cardCount === 1) {
            roomPlayer.hasUno = true;
            
            io.to(room.id).emit('notification', {
                text: `${roomPlayer.nickname} UNO dedi!`,
                type: 'success'
            });
            
            updateGameState(room);
        }
    });
    
    // Respond to challenge
    socket.on('respondChallenge', (data) => {
        // Challenge logic here
    });
    
    // Update player
    socket.on('updatePlayer', (data) => {
        const player = players.get(socket.id);
        if (!player) return;
        
        if (data.avatar) {
            player.avatar = data.avatar;
            
            // Update in room if in one
            if (player.roomId) {
                const room = rooms.get(player.roomId);
                if (room) {
                    const roomPlayer = room.players.find(p => p.id === socket.id);
                    if (roomPlayer) {
                        roomPlayer.avatar = data.avatar;
                        io.to(room.id).emit('roomUpdate', {
                            roomId: room.id,
                            roomName: room.name,
                            players: room.players,
                            settings: room.settings,
                            canStart: room.players.length >= 2 && room.players.every(p => p.isReady)
                        });
                    }
                }
            }
        }
    });
    
    // Leave room
    socket.on('leaveRoom', () => {
        const player = players.get(socket.id);
        if (!player || !player.roomId) return;
        
        const room = rooms.get(player.roomId);
        if (!room) return;
        
        console.log(`👋 Oyuncu ayrılıyor: ${player.nickname} -> ${room.id}`);
        
        // Remove player from room
        room.players = room.players.filter(p => p.id !== socket.id);
        
        // Update player state
        player.roomId = null;
        player.isHost = false;
        player.isReady = false;
        
        // Leave socket room
        socket.leave(room.id);
        
        // If room is empty, delete it
        if (room.players.length === 0) {
            rooms.delete(room.id);
            console.log(`🗑️ Oda silindi: ${room.id}`);
        } else {
            // Assign new host if needed
            if (player.isHost && room.players.length > 0) {
                room.players[0].isHost = true;
                
                // Notify new host
                const newHostSocket = io.sockets.sockets.get(room.players[0].id);
                if (newHostSocket) {
                    newHostSocket.emit('notification', {
                        text: 'Artık odanın sahibi sensin!',
                        type: 'info'
                    });
                }
            }
            
            // Notify remaining players
            io.to(room.id).emit('playerLeft', {
                playerId: socket.id,
                players: room.players
            });
            
            // Send room update
            io.to(room.id).emit('roomUpdate', {
                roomId: room.id,
                roomName: room.name,
                players: room.players,
                settings: room.settings,
                canStart: room.players.length >= 2 && room.players.every(p => p.isReady)
            });
        }
        
        // Send player back to lobby
        socket.emit('roomList', Array.from(rooms.values()).map(r => ({
            id: r.id,
            name: r.name,
            playerCount: r.players.length,
            maxPlayers: 4,
            hasPassword: !!r.password
        })));
    });
    
    // Request rematch
    socket.on('requestRematch', () => {
        const player = players.get(socket.id);
        if (!player || !player.roomId) return;
        
        const room = rooms.get(player.roomId);
        if (!room) return;
        
        // Check if player is host
        if (!player.isHost) {
            socket.emit('notification', {
                text: 'Sadece oda sahibi tekrar oynatabilir!',
                type: 'warning'
            });
            return;
        }
        
        // Reset game state
        room.gameState = 'LOBBY';
        room.players.forEach(p => {
            p.isReady = false;
            p.score = 0;
            p.cardCount = 0;
            p.hasUno = false;
            p.isCurrentTurn = false;
        });
        
        // Send all players back to lobby
        io.to(room.id).emit('roomUpdate', {
            roomId: room.id,
            roomName: room.name,
            players: room.players,
            settings: room.settings,
            canStart: false
        });
        
        io.to(room.id).emit('notification', {
            text: 'Oyun yeniden başlatılıyor!',
            type: 'info'
        });
    });
    
    // Disconnect
    socket.on('disconnect', () => {
        console.log('🔌 Bağlantı kesildi:', socket.id);
        
        const player = players.get(socket.id);
        if (player && player.roomId) {
            const room = rooms.get(player.roomId);
            if (room) {
                // Remove player from room
                room.players = room.players.filter(p => p.id !== socket.id);
                
                // If room is empty, delete it
                if (room.players.length === 0) {
                    rooms.delete(room.id);
                    console.log(`🗑️ Oda silindi: ${room.id}`);
                } else {
                    // Assign new host if needed
                    if (player.isHost && room.players.length > 0) {
                        room.players[0].isHost = true;
                    }
                    
                    // Notify remaining players
                    io.to(room.id).emit('playerLeft', {
                        playerId: socket.id,
                        players: room.players
                    });
                    
                    // Send room update
                    io.to(room.id).emit('roomUpdate', {
                        roomId: room.id,
                        roomName: room.name,
                        players: room.players,
                        settings: room.settings,
                        canStart: room.players.length >= 2 && room.players.every(p => p.isReady)
                    });
                }
            }
        }
        
        // Remove player
        players.delete(socket.id);
    });
});

// Helper functions
function isValidPlay(card, topCard) {
    if (!topCard) return true;
    
    // Wild cards can always be played
    if (card.color === 'black') return true;
    
    // Same color
    const currentColor = topCard.displayColor || topCard.color;
    if (card.color === currentColor) return true;
    
    // Same value/type
    if (card.value === topCard.value || card.type === topCard.type) return true;
    
    return false;
}

function handleSpecialCard(room, card) {
    switch (card.type) {
        case 'skip':
            // Skip next player
            moveToNextPlayer(room);
            break;
            
        case 'reverse':
            // Reverse direction
            room.direction *= -1;
            break;
            
        case 'draw-two':
            // Next player draws 2 cards
            moveToNextPlayer(room);
            const nextPlayer = room.players[room.currentPlayerIndex];
            for (let i = 0; i < 2; i++) {
                if (room.deck.length === 0) {
                    // Reshuffle
                    const topCard = room.discardPile.pop();
                    room.deck = shuffleArray(room.discardPile);
                    room.discardPile = [topCard];
                    room.topCard = topCard;
                }
                nextPlayer.hand.push(room.deck.pop());
            }
            nextPlayer.cardCount = nextPlayer.hand.length;
            // Skip the player who drew cards
            moveToNextPlayer(room);
            break;
            
        case 'wild-draw-four':
            // Next player draws 4 cards
            moveToNextPlayer(room);
            const nextPlayer2 = room.players[room.currentPlayerIndex];
            for (let i = 0; i < 4; i++) {
                if (room.deck.length === 0) {
                    // Reshuffle
                    const topCard = room.discardPile.pop();
                    room.deck = shuffleArray(room.discardPile);
                    room.discardPile = [topCard];
                    room.topCard = topCard;
                }
                nextPlayer2.hand.push(room.deck.pop());
            }
            nextPlayer2.cardCount = nextPlayer2.hand.length;
            // Skip the player who drew cards
            moveToNextPlayer(room);
            break;
    }
}

function moveToNextPlayer(room) {
    room.currentPlayerIndex = (room.currentPlayerIndex + room.direction + room.players.length) % room.players.length;
    
    // Update current turn status
    room.players.forEach((player, index) => {
        player.isCurrentTurn = index === room.currentPlayerIndex;
    });
}

function updateGameState(room) {
    room.players.forEach(player => {
        const playerSocket = io.sockets.sockets.get(player.id);
        if (playerSocket) {
            playerSocket.emit('gameState', {
                hand: player.hand,
                topCard: room.topCard,
                isMyTurn: player.isCurrentTurn,
                gameState: room.gameState,
                players: room.players.map(p => ({
                    id: p.id,
                    nickname: p.nickname,
                    avatar: p.avatar,
                    score: p.score,
                    isHost: p.isHost,
                    isReady: p.isReady,
                    isCurrentTurn: p.isCurrentTurn,
                    cardCount: p.cardCount,
                    hasUno: p.hasUno
                }))
            });
        }
    });
}

function handlePlayerWin(room, winner) {
    room.gameState = 'SCORING';
    
    // Calculate scores
    room.players.forEach(player => {
        if (player.id !== winner.id) {
            let score = 0;
            player.hand.forEach(card => {
                if (card.type === 'number') {
                    score += parseInt(card.value);
                } else if (card.color === 'black') {
                    score += 50; // Wild cards
                } else {
                    score += 20; // Action cards
                }
            });
            winner.score += score;
        }
    });
    
    // Check if winner reached 500 points
    if (winner.score >= 500) {
        // Game over, winner wins the match
        io.to(room.id).emit('gameOver', {
            winner: {
                id: winner.id,
                nickname: winner.nickname,
                avatar: winner.avatar,
                score: winner.score
            },
            players: room.players.map(p => ({
                id: p.id,
                nickname: p.nickname,
                avatar: p.avatar,
                score: p.score,
                finalCards: p.hand
            }))
        });
    } else {
        // Continue to next round
        io.to(room.id).emit('notification', {
            text: `${winner.nickname} eli kazandı! Bir sonraki el başlıyor...`,
            type: 'success'
        });
        
        // Reset for next round
        setTimeout(() => {
            room.gameState = 'PLAYING';
            room.deck = createDeck();
            room.discardPile = [];
            room.currentPlayerIndex = room.players.findIndex(p => p.id === winner.id);
            room.direction = 1;
            
            // Shuffle and deal cards
            room.deck = shuffleArray(room.deck);
            const hands = dealCards(room.deck, room.players.length);
            
            // Assign cards to players
            room.players.forEach((player, index) => {
                player.hand = hands[index];
                player.cardCount = player.hand.length;
                player.hasUno = false;
                player.isCurrentTurn = index === room.currentPlayerIndex;
            });
            
            // Draw first card
            let firstCard;
            do {
                firstCard = room.deck.pop();
            } while (firstCard.color === 'black');
            
            room.topCard = firstCard;
            room.discardPile.push(firstCard);
            
            // Update game state
            updateGameState(room);
        }, 3000);
    }
}

function getCardDisplay(card) {
    const colorNames = {
        'red': 'Kırmızı', 'blue': 'Mavi', 
        'green': 'Yeşil', 'yellow': 'Sarı', 
        'black': 'Joker'
    };
    
    const typeNames = {
        'number': card.value,
        'skip': 'Atlama',
        'reverse': 'Yön Değiştir',
        'draw-two': '+2',
        'wild': 'Joker',
        'wild-draw-four': '+4'
    };
    
    const color = card.displayColor || card.color;
    const colorName = colorNames[color] || color;
    const typeName = typeNames[card.type] || card.type;
    
    return `${colorName} ${typeName}`;
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 UNO PRO sunucusu ${PORT} portunda çalışıyor!`);
});
