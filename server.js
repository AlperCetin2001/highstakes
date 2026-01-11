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
            .filter(r => r.gameState === 'LOBBY') // Sadece lobidekileri göster, oynananları gizle (veya isteğe bağlı gösterilebilir)
            .map(r => ({ id: r.id, name: r.name, count: r.players.length }));
        socket.emit('roomList', list);
    });

    socket.on('createRoom', ({ nickname, avatar }) => {
        const roomId = generateRoomId();
        const room = {
            id: roomId,
            name: `${nickname}'in Odası`,
            hostId: socket.id,
            players: [],
            spectators: [], // İzleyiciler
            gameState: 'LOBBY',
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
            currentColor: null,
            logs: [],
            unoCallers: new Set(),
            pendingChallenge: null,
            timer: null
        };
        rooms.set(roomId, room);
        joinRoomHandler(socket, roomId, nickname, avatar);
    });

    socket.on('joinRoom', ({ roomId, nickname, avatar }) => {
        const room = rooms.get(roomId);
        if (!room) return socket.emit('error', 'Oda bulunamadı.');

        // Eğer oyun oynanıyorsa, Host'a sor
        if (room.gameState === 'PLAYING') {
            // Önce socket'i odaya al ama oyuncu yapma (Spectator)
            socket.join(roomId);
            const spectator = { id: socket.id, nickname, avatar, hand: [], cardCount: 0, isSpectator: true };
            room.spectators.push(spectator);
            
            // Host'a bildirim gönder
            io.to(room.hostId).emit('joinRequest', { 
                playerId: socket.id, 
                nickname: nickname, 
                avatar: avatar 
            });
            
            // Kullanıcıya bilgi ver
            socket.emit('notification', { msg: 'Oda sahibi onayı bekleniyor...', type: 'info' });
        } else {
            // Oyun başlamamışsa direkt gir
            joinRoomHandler(socket, roomId, nickname, avatar);
        }
    });

    // Host'un Katılım Onayı
    socket.on('handleJoinRequest', ({ playerId, approved }) => {
        const roomId = getPlayerRoomId(socket.id); // Host'un odası
        const room = rooms.get(roomId);
        if (!room || room.hostId !== socket.id) return;

        const spectatorIdx = room.spectators.findIndex(s => s.id === playerId);
        if (spectatorIdx === -1) return; // Oyuncu çıkmış olabilir

        const player = room.spectators[spectatorIdx];
        room.spectators.splice(spectatorIdx, 1); // İzleyicilerden sil

        if (approved) {
            // Oyuna dahil et
            player.isSpectator = false;
            // Kart çekip verelim
            drawCards(room, player, 7);
            room.players.push(player);
            
            addLog(room, `${player.nickname} oyuna sonradan dahil oldu!`);
            io.to(playerId).emit('notification', { msg: 'Oyuna kabul edildin! İyi şanslar.', type: 'success' });
        } else {
            // Reddedildi, izleyici olarak kalsın (Zaten sildik ama players'a eklemiyoruz, sadece odayı izler)
            // Daha iyi deneyim için spectators array'inde tutmaya devam edebiliriz ama oyuncu listesinde görünmez.
            // Bizim yapımızda spectators sadece "izleyen" demek.
            room.spectators.push(player);
            io.to(playerId).emit('notification', { msg: 'Bu el için katılım reddedildi. İzleyici modundasın.', type: 'warning' });
        }
        broadcastGameState(roomId);
    });

    socket.on('startGame', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        
        if (!room || room.hostId !== socket.id) return;
        if (room.players.length < 2) return socket.emit('error', 'En az 2 oyuncu gerekli!');

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
        
        addLog(room, "Oyun Başladı! Bol şans.");
        broadcastGameState(roomId);
        startTurnTimer(room);
    });

    // --- PLAY CARD (GÜNCELLENDİ: Çoklu Kart Desteği) ---
    socket.on('playCard', ({ cardIndices, chosenColor }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);

        if (room.players[room.turnIndex].id !== socket.id) return;
        if (room.pendingChallenge) return;

        // Kartları al (Indices array geliyor artık)
        // İndeksleri büyükten küçüğe sırala ki silerken kayma olmasın
        cardIndices.sort((a, b) => b - a);
        
        const cardsToPlay = cardIndices.map(idx => player.hand[idx]);
        const firstCard = cardsToPlay[cardsToPlay.length - 1]; // Mantıken hepsi aynı olmalı
        const top = room.discardPile[room.discardPile.length - 1];

        // ÇOKLU KART KONTROLÜ
        // 1. Hepsi aynı değere sahip mi?
        const allSameValue = cardsToPlay.every(c => c.value === firstCard.value);
        if (!allSameValue) return socket.emit('error', 'Sadece aynı sayıdaki kartları birlikte atabilirsin.');

        // 2. İlk kart yere uyuyor mu?
        let isValid = (firstCard.color === 'black') || (firstCard.color === room.currentColor) || (firstCard.value === top.value);
        
        if (isValid) {
            resetTurnTimer(room);

            // Kartları elden çıkar ve yere at
            cardIndices.forEach(idx => {
                player.hand.splice(idx, 1);
            });
            
            // Yere atılan kartları discard'a ekle. En sonuncusu en üstte kalır.
            // Önemli: Efekt sadece EN SON atılan kart için geçerli olur (Genel kural).
            cardsToPlay.forEach(c => room.discardPile.push(c));
            
            const lastPlayedCard = cardsToPlay[0]; // Dizideki ilk eleman (aslında son atılan)
            
            room.currentColor = (lastPlayedCard.color === 'black') ? chosenColor : lastPlayedCard.color;

            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            const count = cardsToPlay.length;
            addLog(room, `${player.nickname} ${count > 1 ? count + ' adet ' : ''}${formatCardName(lastPlayedCard)} oynadı.`);

            // Efekti uygula (Sadece son kartın efekti)
            handleCardEffect(room, lastPlayedCard, player);
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
        addLog(room, `${room.players[room.turnIndex].nickname} kart çekti.`);
        advanceTurn(room);
        broadcastGameState(roomId);
        startTurnTimer(room);
    });

    socket.on('callUno', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player.hand.length <= 2) {
            room.unoCallers.add(player.id);
            addLog(room, `📢 ${player.nickname}: "UNO!"`);
            io.to(roomId).emit('playSound', 'uno');
            broadcastGameState(roomId);
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
            addLog(room, `${victim.nickname} cezayı kabul etti.`);
            drawCards(room, victim, 4);
        } else {
            const hasColor = attacker.hand.some(c => c.color === oldColor && c.color !== 'black');
            if (hasColor) {
                addLog(room, `⚖️ YAKALANDI! ${attacker.nickname} blöf yaptı!`);
                drawCards(room, attacker, 4);
            } else {
                addLog(room, `⚖️ TEMİZ! ${attacker.nickname} dürüst oynadı.`);
                drawCards(room, victim, 6);
            }
        }
        room.pendingChallenge = null;
        advanceTurn(room);
        broadcastGameState(roomId);
        startTurnTimer(room);
    });

    socket.on('disconnect', () => {
        const roomId = getPlayerRoomId(socket.id);
        if(roomId) {
            const room = rooms.get(roomId);
            // Oyuncuysa sil, izleyiciyse sil
            room.players = room.players.filter(p => p.id !== socket.id);
            room.spectators = room.spectators.filter(s => s.id !== socket.id);
            
            if(room.players.length === 0 && room.spectators.length === 0) {
                if(room.timer) clearTimeout(room.timer);
                rooms.delete(roomId);
            } else {
                if(room.hostId === socket.id && room.players.length > 0) room.hostId = room.players[0].id;
                broadcastGameState(roomId);
            }
        }
    });
});

// --- YARDIMCILAR (Aynı Kalabilir, Sadece Timer ve Log Güncellemeleri) ---
function handleCardEffect(room, card, player) {
    let skipTurn = false;
    if (card.value === 'skip') { skipTurn = true; addLog(room, "Sıra atladı!"); } 
    else if (card.value === 'reverse') {
        room.direction *= -1;
        addLog(room, "Yön değişti!");
        if (room.players.length === 2) { skipTurn = true; }
    }
    else if (card.value === 'draw2') {
        const next = getNextPlayer(room);
        drawCards(room, next, 2);
        addLog(room, `${next.nickname} +2 yedi!`);
        skipTurn = true;
    }
    else if (card.value === 'wild4') {
        const nextIdx = getNextPlayerIndex(room);
        const nextPlayer = room.players[nextIdx];
        room.pendingChallenge = { attackerId: player.id, victimId: nextPlayer.id, oldColor: room.currentColor }; // oldColor basit tutuldu
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
    startTurnTimer(room);
}

function startTurnTimer(room) {
    if(room.timer) clearTimeout(room.timer);
    let timeLeft = 60; // 60 Saniye
    
    // Her saniye süreyi güncelle ve istemcilere yolla (opsiyonel, veya sadece bitişi bekle)
    // Performans için sadece başlangıç zamanını yollayıp client'ta saydırabiliriz.
    // Ancak basitlik için: Server 60sn bekler.
    
    // İstemcilere "Süre başladı" bilgisi
    const turnStart = Date.now();
    room.turnDeadline = turnStart + 60000;
    
    room.timer = setTimeout(() => {
        const currentPlayer = room.players[room.turnIndex];
        drawCards(room, currentPlayer, 1);
        addLog(room, `${currentPlayer.nickname} süre doldu.`);
        advanceTurn(room);
        broadcastGameState(room.id);
        startTurnTimer(room);
    }, 60000);
}

function resetTurnTimer(room) { if(room.timer) clearTimeout(room.timer); }

function finishGame(room, winner) {
    if(room.timer) clearTimeout(room.timer);
    let totalScore = 0;
    room.players.forEach(p => { p.hand.forEach(c => totalScore += c.score); });
    
    io.to(room.id).emit('gameOver', { 
        winner: winner.nickname, score: totalScore, players: room.players
    });

    setTimeout(() => {
        room.gameState = 'LOBBY';
        room.players.forEach(p => { p.hand = []; p.cardCount = 0; p.hasUno = false; });
        room.deck = []; room.discardPile = [];
        broadcastGameState(room.id);
    }, 6000);
}

function joinRoomHandler(socket, roomId, nickname, avatar) {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error', 'Oda yok.');
    socket.join(roomId);
    const existing = room.players.find(p => p.id === socket.id);
    if(!existing && !room.spectators.find(s => s.id === socket.id)) {
        room.players.push({ id: socket.id, nickname, avatar, hand: [] });
    }
    broadcastGameState(roomId);
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
        if (room.players.find(p => p.id === socketId) || room.spectators.find(s => s.id === socket.id)) return id;
    }
    return null;
}
function addLog(room, msg) { room.logs.push(msg); if(room.logs.length > 6) room.logs.shift(); }
function formatCardName(c) { 
    if(c.color === 'black') return c.value === 'wild' ? 'Joker' : '+4 Joker';
    return `${c.color.toUpperCase()} ${c.value}`;
}
function broadcastGameState(roomId) {
    const room = rooms.get(roomId);
    if(!room) return;
    
    // Hem oyunculara hem izleyicilere gönder
    const allSockets = [...room.players, ...room.spectators];

    allSockets.forEach(p => {
        const socket = io.sockets.sockets.get(p.id);
        if (socket) {
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
                myHand: p.hand, // İzleyiciyse boş gelir
                topCard: room.discardPile[room.discardPile.length-1],
                currentColor: room.currentColor,
                logs: room.logs,
                turnOwner: room.players[room.turnIndex]?.nickname || '---',
                isMyTurn: room.players[room.turnIndex]?.id === p.id,
                turnDeadline: room.turnDeadline // Geri sayım için
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('UNO ULTIMATE SERVER AKTİF!'));
