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
        const list = Array.from(rooms.values()).map(r => ({ 
            id: r.id, name: r.name, count: r.players.length, status: r.gameState 
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
            gameState: 'LOBBY',
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
            currentColor: null,
            logs: [], // Hem chat hem oyun logları
            unoCallers: new Set(),
            pendingChallenge: null,
            timer: null,
            turnDeadline: 0
        };
        rooms.set(roomId, room);
        joinRoomHandler(socket, roomId, nickname, avatar);
    });

    socket.on('joinRoom', ({ roomId, nickname, avatar }) => {
        const room = rooms.get(roomId);
        if (!room) return socket.emit('error', 'Oda bulunamadı.');

        if (room.gameState === 'PLAYING') {
            const joinerData = { id: socket.id, nickname, avatar };
            io.to(room.hostId).emit('joinRequest', joinerData);
            socket.emit('notification', { msg: 'Oda sahibine istek gönderildi...', type: 'info' });
        } else {
            joinRoomHandler(socket, roomId, nickname, avatar);
        }
    });

    socket.on('handleJoinRequest', ({ joinerId, accept }) => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        const joinerSocket = io.sockets.sockets.get(joinerId);

        if (!room || !joinerSocket) return;

        if (accept) {
            joinerSocket.join(roomId);
            const newPlayer = { 
                id: joinerId, 
                nickname: joinerSocket.handshake.query.nickname || 'Misafir',
                avatar: '👤',
                hand: [],
                score: 0 
            };
            
            // Eğer oyun oynanıyorsa kart ver
            if (room.gameState === 'PLAYING') {
                ensureDeck(room);
                newPlayer.hand = room.deck.length >= 7 ? room.deck.splice(0, 7) : [];
            }
            
            room.players.push(newPlayer);
            addLog(room, `Yeni oyuncu katıldı!`, 'system');
            broadcastGameState(roomId);
        } else {
            joinerSocket.emit('error', 'Katılım reddedildi.');
        }
    });

    socket.on('startGame', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        
        if (!room || room.hostId !== socket.id) return;
        if (room.players.length < 2) {
            socket.emit('error', 'En az 2 oyuncu gerekli!');
            return;
        }

        room.gameState = 'PLAYING';
        room.deck = createDeck();
        room.discardPile = [];
        room.direction = 1;
        
        // --- RASTGELE BAŞLANGIÇ ---
        room.turnIndex = Math.floor(Math.random() * room.players.length);
        
        room.unoCallers.clear();
        room.logs = [];
        room.pendingChallenge = null;
        
        room.players.forEach(p => { p.hand = room.deck.splice(0, 7); });

        let first;
        do { first = room.deck.pop(); } while (first.color === 'black');
        
        room.discardPile.push(first);
        room.currentColor = first.color;
        
        addLog(room, "Oyun Başladı! Bol Şans.", 'system');
        
        // İlk kart efekt kontrolü (reverse/skip varsa)
        if (first.value === 'skip') {
             addLog(room, `İlk kart BLOK! ${room.players[room.turnIndex].nickname} atlandı.`, 'game');
             advanceTurn(room);
        } else if (first.value === 'reverse') {
             room.direction *= -1;
             if(room.players.length === 2) advanceTurn(room); // 2 kişiyse skip gibi davranır
        }

        startTurnTimer(room);
        broadcastGameState(roomId);
    });

    socket.on('sendMessage', ({ message }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);
        if(player) {
            addLog(room, `${player.nickname}: ${message}`, 'chat');
            broadcastGameState(roomId);
        }
    });

    socket.on('playCard', ({ cardIndex, chosenColor }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);

        if (room.players[room.turnIndex].id !== socket.id) return;
        if (room.pendingChallenge) return;
        if (!player.hand[cardIndex]) return;

        const card = player.hand[cardIndex];
        const top = room.discardPile[room.discardPile.length - 1];
        
        let isValid = false;
        if (card.color === 'black') isValid = true;
        else if (card.color === room.currentColor) isValid = true;
        else if (card.value === top.value) isValid = true;

        if (isValid) {
            resetTurnTimer(room);
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            
            const oldColorForChallenge = room.currentColor;
            room.currentColor = (card.color === 'black') ? chosenColor : card.color;

            // --- UNO CEZA KONTROLÜ (GELİŞTİRİLMİŞ) ---
            // Oyuncu kartı attıktan sonra elinde 0 kart kalırsa (bitti) ceza yok.
            // Ama elinde 1 kart kaldıysa ve UNO dememişse ceza.
            if (player.hand.length === 1) {
                if (!room.unoCallers.has(player.id)) {
                    addLog(room, `🚨 ${player.nickname} UNO demeyi unuttu! +2 Ceza!`, 'warning');
                    drawCards(room, player, 2);
                }
            }
            // Kart attıktan sonra elinde kart kalmadıysa veya 1'den fazla varsa uno durumunu sil
            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} attı: ${formatCardName(card)}`, 'game');
            handleCardEffect(room, card, player, oldColorForChallenge);
        } else {
            socket.emit('error', 'Bu kartı oynayamazsın!');
        }
    });

    socket.on('drawCard', () => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        
        if (room.players[room.turnIndex].id !== socket.id) return;
        if (room.pendingChallenge) return;

        resetTurnTimer(room);
        drawCards(room, room.players[room.turnIndex], 1);
        addLog(room, `${room.players[room.turnIndex].nickname} kart çekti.`, 'game');
        advanceTurn(room);
        broadcastGameState(roomId);
        startTurnTimer(room);
    });

    socket.on('callUno', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room) return;
        const player = room.players.find(p => p.id === socket.id);
        
        // Elinde 2 kart varken (atmadan önce) veya 1 kart varken diyebilir
        if (player.hand.length <= 2) {
            if(!room.unoCallers.has(player.id)) {
                room.unoCallers.add(player.id);
                addLog(room, `${player.nickname} UNO dedi!`, 'warning');
                io.to(roomId).emit('playSound', 'uno');
                broadcastGameState(roomId);
            }
        }
    });

    socket.on('challengeDecision', ({ decision }) => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room || !room.pendingChallenge) return;

        const { victimId, attackerId, oldColor } = room.pendingChallenge;
        if (socket.id !== victimId) return;

        const attacker = room.players.find(p => p.id === attackerId);
        const victim = room.players.find(p => p.id === victimId);

        if (decision === 'accept') {
            addLog(room, `${victim.nickname} +4'ü kabul etti.`, 'game');
            drawCards(room, victim, 4);
            advanceTurn(room); 
        } else {
            // Blöf kontrolü: Atan kişinin elinde, eski renkten kart var mı?
            const hasColor = attacker.hand.some(c => c.color === oldColor && c.color !== 'black');
            if (hasColor) {
                addLog(room, `⚖️ YAKALANDI! ${attacker.nickname} blöf yapmıştı! (+4 Ceza)`, 'warning');
                drawCards(room, attacker, 4);
                // Sıra mağdurda kalmalı mı? Orijinal kurallara göre sıra mağdura geçer ama +4 çekmez.
                // Burada mağdur oynamadan sırayı geçirelim (standart house rule).
                // Ama kart çekmediği için oynayabilir. Biz basitleştirip sırayı geçirelim.
                advanceTurn(room);
            } else {
                addLog(room, `⚖️ TEMİZ! ${attacker.nickname} dürüsttü. ${victim.nickname} 6 kart çekiyor!`, 'warning');
                drawCards(room, victim, 6);
                advanceTurn(room);
            }
        }

        room.pendingChallenge = null;
        broadcastGameState(roomId);
        startTurnTimer(room);
    });

    socket.on('disconnect', () => {
        const roomId = getPlayerRoomId(socket.id);
        if(roomId) {
            const room = rooms.get(roomId);
            room.players = room.players.filter(p => p.id !== socket.id);
            if(room.players.length === 0) {
                if(room.timer) clearTimeout(room.timer);
                rooms.delete(roomId);
            } else {
                if(room.hostId === socket.id) room.hostId = room.players[0].id;
                // Oyun sırasında biri çıkarsa
                if(room.gameState === 'PLAYING') {
                     addLog(room, "Bir oyuncu ayrıldı.", 'system');
                     if(room.players.length < 2) {
                         room.gameState = 'LOBBY'; // Oyunu bitir
                         addLog(room, "Yetersiz oyuncu. Lobiye dönüldü.", 'system');
                     } else {
                         // Eğer sıradaki kişi çıktıysa sırayı düzelt
                         if(room.turnIndex >= room.players.length) room.turnIndex = 0;
                     }
                }
                broadcastGameState(roomId);
            }
        }
    });
});

// --- OYUN MANTIĞI ---

function handleCardEffect(room, card, player, oldColorForChallenge) {
    let skipNext = false;

    if (card.value === 'skip') { 
        skipNext = true; 
        addLog(room, "Sıra atladı!", 'game'); 
    } 
    else if (card.value === 'reverse') {
        room.direction *= -1;
        addLog(room, "Yön değişti!", 'game');
        if (room.players.length === 2) { skipNext = true; } 
    }
    else if (card.value === 'draw2') {
        const next = getNextPlayer(room); 
        drawCards(room, next, 2);
        addLog(room, `${next.nickname} +2 yedi!`, 'game');
        skipNext = true; 
    }
    else if (card.value === 'wild4') {
        const nextIdx = getNextPlayerIndex(room);
        const nextPlayer = room.players[nextIdx];
        
        room.pendingChallenge = { 
            attackerId: player.id, 
            victimId: nextPlayer.id, 
            oldColor: oldColorForChallenge 
        };
        
        io.to(nextPlayer.id).emit('challengePrompt', { attacker: player.nickname });
        broadcastGameState(room.id);
        return; // Timer durur, karar beklenir
    }

    if (player.hand.length === 0) {
        finishGame(room, player);
        return;
    }

    advanceTurn(room);
    if (skipNext) advanceTurn(room);
    broadcastGameState(room.id);
    startTurnTimer(room);
}

function startTurnTimer(room) {
    if(room.timer) clearTimeout(room.timer);
    
    // Süreyi sunucu saatiyle belirle
    const duration = 30000; // 30 saniye
    room.turnDeadline = Date.now() + duration;
    
    room.timer = setTimeout(() => {
        const currentPlayer = room.players[room.turnIndex];
        // Sadece oyuncu hala odadaysa işlem yap
        if (currentPlayer) {
            drawCards(room, currentPlayer, 1);
            addLog(room, `${currentPlayer.nickname} süre doldu, kart çekti.`, 'game');
            advanceTurn(room);
            broadcastGameState(room.id);
            startTurnTimer(room); // Sonraki oyuncu için zamanı başlat
        }
    }, duration);
}

function resetTurnTimer(room) { if(room.timer) clearTimeout(room.timer); }

function finishGame(room, winner) {
    if(room.timer) clearTimeout(room.timer);
    let totalScore = 0;
    room.players.forEach(p => { p.hand.forEach(c => totalScore += c.score); });
    
    io.to(room.id).emit('gameOver', { 
        winner: winner.nickname, 
        score: totalScore,
        players: room.players
    });

    setTimeout(() => {
        room.gameState = 'LOBBY';
        room.players.forEach(p => {
            p.hand = [];
            p.score += (p.id === winner.id ? totalScore : 0); // Basit skor tutma
        });
        room.deck = [];
        room.discardPile = [];
        room.pendingChallenge = null;
        broadcastGameState(room.id);
    }, 8000);
}

function joinRoomHandler(socket, roomId, nickname, avatar) {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error', 'Oda yok.');
    socket.join(roomId);
    
    // Zaten varsa güncelle, yoksa ekle
    const existing = room.players.find(p => p.id === socket.id);
    if(!existing) {
        room.players.push({ id: socket.id, nickname, avatar, hand: [], score: 0 });
    } else {
        existing.nickname = nickname;
        existing.avatar = avatar;
    }
    broadcastGameState(roomId);
}

// Güvenli Deste Çekme (Sonsuz döngü engelli)
function ensureDeck(room) {
    if(room.deck.length === 0) {
        if(room.discardPile.length > 1) {
            const top = room.discardPile.pop();
            room.deck = shuffle(room.discardPile);
            room.discardPile = [top];
            addLog(room, "Deste karıştırıldı.", 'system');
        } else {
             // Eğer hem deste hem yer boşsa (imkansız ama tedbir)
             addLog(room, "Kartlar bitti! Oyun berabere.", 'system');
             finishGame(room, { nickname: "Kimse" });
        }
    }
}

function drawCards(room, player, count) {
    for(let i=0; i<count; i++) {
        ensureDeck(room);
        if (room.deck.length > 0) {
            player.hand.push(room.deck.pop());
        } else {
            break; // Kart kalmadıysa çekmeyi bırak
        }
    }
}

function advanceTurn(room) {
    if (room.players.length === 0) return;
    room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
}

function getNextPlayerIndex(room) {
    return (room.turnIndex + room.direction + room.players.length) % room.players.length;
}
function getNextPlayer(room) { return room.players[getNextPlayerIndex(room)]; }

function getPlayerRoomId(socketId) {
    for (const [id, room] of rooms) {
        if (room.players.find(p => p.id === socketId)) return id;
    }
    return null;
}

function addLog(room, msg, type = 'game') {
    // type: 'game', 'chat', 'system', 'warning'
    room.logs.push({ msg, type, time: Date.now() });
    if(room.logs.length > 50) room.logs.shift(); // 50 mesaj hafızası
}

function formatCardName(c) {
    if(c.color === 'black') return c.value === 'wild' ? 'Joker' : '+4 Joker';
    return `${c.color.toUpperCase()} ${c.value}`;
}

function broadcastGameState(roomId) {
    const room = rooms.get(roomId);
    if(!room) return;

    room.players.forEach(p => {
        const socket = io.sockets.sockets.get(p.id);
        if (socket) {
            // "Oynuyor" durumu kimin?
            const turnPlayerId = room.players[room.turnIndex] ? room.players[room.turnIndex].id : null;

            socket.emit('roomUpdate', {
                roomId: room.id,
                isHost: (p.id === room.hostId),
                gameState: room.gameState,
                players: room.players.map(pl => ({ 
                    id: pl.id, 
                    nickname: pl.nickname, 
                    avatar: pl.avatar,
                    cardCount: pl.hand.length,
                    hasUno: room.unoCallers.has(pl.id),
                    isTurn: pl.id === turnPlayerId, // Bu oyuncunun sırası mı?
                    score: pl.score
                })),
                myHand: p.hand,
                topCard: room.discardPile[room.discardPile.length-1],
                currentColor: room.currentColor,
                logs: room.logs,
                turnDeadline: room.turnDeadline,
                pendingChallenge: !!room.pendingChallenge
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`UNO Server ${PORT} portunda aktif!`));
