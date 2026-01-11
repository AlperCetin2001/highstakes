const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = new Map();

// --- YARDIMCI FONKSİYONLAR ---
function generateRoomId() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function createDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const deck = [];

    colors.forEach(color => {
        deck.push({ color, value: '0', type: 'number', score: 0, id: Math.random().toString(36) });
        for (let i = 1; i <= 9; i++) {
            deck.push({ color, value: i.toString(), type: 'number', score: i, id: Math.random().toString(36) });
            deck.push({ color, value: i.toString(), type: 'number', score: i, id: Math.random().toString(36) });
        }
        ['skip', 'reverse', 'draw2'].forEach(val => {
            deck.push({ color, value: val, type: 'action', score: 20, id: Math.random().toString(36) });
            deck.push({ color, value: val, type: 'action', score: 20, id: Math.random().toString(36) });
        });
    });

    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'black', value: 'wild', type: 'wild', score: 50, id: Math.random().toString(36) });
        deck.push({ color: 'black', value: 'wild4', type: 'wild', score: 50, id: Math.random().toString(36) });
    }

    return shuffle(deck);
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// --- SOCKET MANTIĞI ---
io.on('connection', (socket) => {
    
    socket.on('getRooms', () => {
        const list = Array.from(rooms.values())
            .map(r => ({ 
                id: r.id, 
                name: r.name, 
                count: r.players.length,
                state: r.gameState 
            }));
        socket.emit('roomList', list);
    });

    socket.on('createRoom', ({ nickname, avatar }) => {
        const roomId = generateRoomId();
        const room = {
            id: roomId,
            name: `${nickname}'in Odası`,
            hostId: socket.id,
            players: [],
            spectators: [], // İzleyiciler (Onay bekleyenler)
            gameState: 'LOBBY',
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
            currentColor: null,
            logs: [],
            unoCallers: new Set(),
            pendingChallenge: null,
            timer: null,
            turnStartTime: 0
        };
        rooms.set(roomId, room);
        handleJoin(socket, room, nickname, avatar);
    });

    socket.on('joinRoom', ({ roomId, nickname, avatar }) => {
        const room = rooms.get(roomId);
        if (!room) return socket.emit('error', 'Oda bulunamadı.');
        handleJoin(socket, room, nickname, avatar);
    });

    // Host, sonradan gelen oyuncuyu kabul ederse
    socket.on('approveJoin', ({ targetSocketId, approve }) => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room || room.hostId !== socket.id) return;

        const spectatorIndex = room.spectators.findIndex(p => p.id === targetSocketId);
        if(spectatorIndex === -1) return;

        const player = room.spectators[spectatorIndex];
        
        if (approve) {
            // Oyuna al
            room.spectators.splice(spectatorIndex, 1);
            
            // Kart ver
            if (room.gameState === 'PLAYING') {
                drawCards(room, player, 7);
            }
            
            room.players.push(player);
            addLog(room, `${player.nickname} oyuna dahil oldu!`);
            
            io.to(targetSocketId).emit('joinApproved');
            broadcastGameState(roomId);
        } else {
            // Reddet (Sadece izleyici kalsın veya atılsın - burada izleyici kalıyor ama oynayamıyor)
            io.to(targetSocketId).emit('error', 'Oda sahibi şu an oyuna alımı kapattı. İzleyici modundasınız.');
        }
    });

    socket.on('startGame', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        
        if (!room || room.hostId !== socket.id) return;
        if (room.players.length < 2) return socket.emit('error', 'En az 2 oyuncu gerekli!');

        startGameLogic(room);
    });

    socket.on('playCard', ({ cardIndex, chosenColor }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);

        if (!player || room.players[room.turnIndex].id !== socket.id) return;
        if (room.pendingChallenge) return;

        const card = player.hand[cardIndex];
        const top = room.discardPile[room.discardPile.length - 1];
        
        // Çoklu Kart Atma Kontrolü (Aynı sayıdan varsa)
        // Orijinal UNO'da bu kural standart değil ama istendiği için basitleştirilmiş "Jump-In" mantığı:
        // Şimdilik stabilite için tekli kart devam ediyoruz, çünkü çoklu seçim UI mobilde zor.
        
        let isValid = (card.color === 'black') || (card.color === room.currentColor) || (card.value === top.value);
        
        if (isValid) {
            resetTimer(room);
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            room.currentColor = (card.color === 'black') ? chosenColor : card.color;
            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} attı: ${formatCardName(card)}`);
            io.to(roomId).emit('playSound', 'play');
            
            handleCardEffect(room, card, player);
        }
    });

    socket.on('drawCard', () => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (room.players[room.turnIndex].id !== socket.id) return;

        resetTimer(room);
        drawCards(room, room.players[room.turnIndex], 1);
        addLog(room, `${room.players[room.turnIndex].nickname} çekti.`);
        io.to(roomId).emit('playSound', 'draw');
        advanceTurn(room);
        broadcastGameState(roomId);
        startTimer(room);
    });

    socket.on('callUno', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        const player = room.players?.find(p => p.id === socket.id);
        if(player && player.hand.length <= 2) {
            room.unoCallers.add(player.id);
            io.to(roomId).emit('notification', { msg: `${player.nickname} UNO dedi!`, type: 'warning' });
            io.to(roomId).emit('playSound', 'uno');
            broadcastGameState(roomId);
        }
    });

    socket.on('challengeDecision', ({ decision }) => {
        // Challenge mantığı aynen korundu
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room || !room.pendingChallenge) return;
        
        const { victimId, attackerId, oldColor } = room.pendingChallenge;
        if (socket.id !== victimId) return;
        
        const attacker = room.players.find(p => p.id === attackerId);
        const victim = room.players.find(p => p.id === victimId);
        
        resetTimer(room);

        if (decision === 'accept') {
            addLog(room, `${victim.nickname} kabul etti.`);
            drawCards(room, victim, 4);
        } else {
            const hasColor = attacker.hand.some(c => c.color === oldColor && c.color !== 'black');
            if (hasColor) {
                addLog(room, `BLÖF YAKALANDI! ${attacker.nickname} ceza çekiyor.`);
                drawCards(room, attacker, 4);
            } else {
                addLog(room, `BLÖF DEĞİL! ${victim.nickname} +6 çekiyor.`);
                drawCards(room, victim, 6);
            }
        }
        room.pendingChallenge = null;
        advanceTurn(room);
        broadcastGameState(roomId);
        startTimer(room);
    });

    socket.on('disconnect', () => {
        const roomId = getPlayerRoomId(socket.id);
        if(roomId) {
            const room = rooms.get(roomId);
            // Hem oyuncu hem izleyici listesinden sil
            room.players = room.players.filter(p => p.id !== socket.id);
            room.spectators = room.spectators.filter(p => p.id !== socket.id);

            if(room.players.length === 0 && room.spectators.length === 0) {
                if(room.timer) clearTimeout(room.timer);
                rooms.delete(roomId);
            } else {
                if(room.hostId === socket.id) {
                    // Yeni host ata
                    if(room.players.length > 0) room.hostId = room.players[0].id;
                    else if(room.spectators.length > 0) room.hostId = room.spectators[0].id;
                }
                broadcastGameState(roomId);
            }
        }
    });
});

function handleJoin(socket, room, nickname, avatar) {
    socket.join(room.id);
    const newPlayer = { id: socket.id, nickname, avatar, hand: [], cardCount: 0 };

    if (room.gameState === 'LOBBY') {
        // Lobi ise direkt gir
        room.players.push(newPlayer);
        broadcastGameState(room.id);
    } else {
        // Oyun başladıysa izleyiciye al ve Host'a sor
        room.spectators.push(newPlayer);
        // Host'a bildirim gönder
        io.to(room.hostId).emit('playerRequestJoin', { 
            socketId: socket.id, 
            nickname 
        });
        // Oyuncuya bekleme ekranı göster
        socket.emit('waitingForHost');
        broadcastGameState(room.id); // İzleyici olarak listede görünsün
    }
}

function startGameLogic(room) {
    room.gameState = 'PLAYING';
    room.deck = createDeck();
    room.discardPile = [];
    room.direction = 1;
    room.turnIndex = 0;
    room.unoCallers.clear();
    room.logs = [];
    
    room.players.forEach(p => { p.hand = room.deck.splice(0, 7); });

    let first;
    do { first = room.deck.pop(); } while (first.color === 'black');
    room.discardPile.push(first);
    room.currentColor = first.color;
    
    addLog(room, "Oyun Başladı!");
    broadcastGameState(room.id);
    startTimer(room);
}

function startTimer(room) {
    if(room.timer) clearTimeout(room.timer);
    room.turnStartTime = Date.now();
    
    room.timer = setTimeout(() => {
        // Süre doldu (60sn)
        const currentPlayer = room.players[room.turnIndex];
        if(currentPlayer) {
            drawCards(room, currentPlayer, 1);
            addLog(room, `${currentPlayer.nickname} süre doldu (Pas).`);
            advanceTurn(room);
            broadcastGameState(room.id);
            startTimer(room);
        }
    }, 60000); // 60 Saniye
}

function resetTimer(room) {
    if(room.timer) clearTimeout(room.timer);
}

function handleCardEffect(room, card, player) {
    let skipTurn = false;
    if (card.value === 'skip') { skipTurn = true; addLog(room, "Sıra atladı!"); } 
    else if (card.value === 'reverse') {
        room.direction *= -1;
        if (room.players.length === 2) skipTurn = true;
    }
    else if (card.value === 'draw2') {
        const next = getNextPlayer(room);
        drawCards(room, next, 2);
        skipTurn = true;
    }
    else if (card.value === 'wild4') {
        const nextIdx = getNextPlayerIndex(room);
        const nextPlayer = room.players[nextIdx];
        room.pendingChallenge = { attackerId: player.id, victimId: nextPlayer.id, oldColor: room.currentColor };
        io.to(nextPlayer.id).emit('challengePrompt', { attacker: player.nickname });
        broadcastGameState(room.id);
        return;
    }

    if (player.hand.length === 0) {
        finishGame(room, player);
        return;
    }

    advanceTurn(room);
    if (skipTurn) advanceTurn(room);
    broadcastGameState(room.id);
    startTimer(room);
}

function finishGame(room, winner) {
    resetTimer(room);
    let totalScore = 0;
    room.players.forEach(p => { p.hand.forEach(c => totalScore += c.score); });
    
    io.to(room.id).emit('gameOver', { 
        winner: winner.nickname, 
        avatar: winner.avatar,
        score: totalScore,
        players: room.players
    });

    setTimeout(() => {
        room.gameState = 'LOBBY';
        room.players.forEach(p => { p.hand = []; p.cardCount = 0; p.hasUno = false; });
        room.deck = []; room.discardPile = [];
        broadcastGameState(room.id);
    }, 8000);
}

function drawCards(room, player, count) {
    for(let i=0; i<count; i++) {
        if(room.deck.length === 0) {
            if(room.discardPile.length > 1) {
                const top = room.discardPile.pop();
                room.deck = shuffle(room.discardPile);
                room.discardPile = [top];
            } else break;
        }
        player.hand.push(room.deck.pop());
    }
}

function advanceTurn(room) {
    room.turnIndex += room.direction;
    if (room.turnIndex >= room.players.length) room.turnIndex = 0;
    if (room.turnIndex < 0) room.turnIndex = room.players.length - 1;
}

function getNextPlayerIndex(room) {
    let idx = room.turnIndex + room.direction;
    if (idx >= room.players.length) idx = 0;
    if (idx < 0) idx = room.players.length - 1;
    return idx;
}
function getNextPlayer(room) { return room.players[getNextPlayerIndex(room)]; }

function getPlayerRoomId(socketId) {
    for (const [id, room] of rooms) {
        if (room.players.find(p => p.id === socketId) || room.spectators.find(p => p.id === socketId)) return id;
    }
    return null;
}

function addLog(room, msg) {
    room.logs.push(msg);
    if(room.logs.length > 5) room.logs.shift();
}

function formatCardName(c) {
    if(c.color === 'black') return c.value === 'wild' ? 'Joker' : '+4 Joker';
    return `${c.color.toUpperCase()} ${c.value}`;
}

function broadcastGameState(roomId) {
    const room = rooms.get(roomId);
    if(!room) return;

    // Herkese (Oyuncular + İzleyiciler) durumu gönder
    const allSockets = [...room.players, ...room.spectators];
    
    allSockets.forEach(p => {
        const socket = io.sockets.sockets.get(p.id);
        if (socket) {
            // Süre hesapla
            const timeLeft = room.timer ? Math.max(0, 60 - Math.floor((Date.now() - room.turnStartTime)/1000)) : 60;
            
            socket.emit('roomUpdate', {
                roomId: room.id,
                isHost: (p.id === room.hostId),
                gameState: room.gameState,
                playerCount: room.players.length,
                players: room.players.map(pl => ({ 
                    id: pl.id, 
                    nickname: pl.nickname, 
                    avatar: pl.avatar,
                    cardCount: pl.hand.length,
                    hasUno: room.unoCallers.has(pl.id)
                })),
                myHand: room.players.find(x => x.id === p.id)?.hand || [], // İzleyiciyse eli boştur
                topCard: room.discardPile[room.discardPile.length-1],
                currentColor: room.currentColor,
                logs: room.logs,
                turnOwner: room.players[room.turnIndex]?.nickname || "---",
                isMyTurn: room.players[room.turnIndex]?.id === p.id,
                timeLeft: timeLeft
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('UNO Sunucusu Aktif!'));
