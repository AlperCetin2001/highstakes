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
            logs: [], // Yapı: { type: 'system'|'chat'|'private', msg: string, sender: string, to: string }
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

        // Eğer oyun oynanıyorsa ve bu kişi zaten listede yoksa istek at
        const existingPlayer = room.players.find(p => p.nickname === nickname); // Basit kontrol, ID daha iyi olurdu ama reload için nickname bakıyoruz
        
        if (room.gameState === 'PLAYING' && !existingPlayer) {
            const joinerData = { id: socket.id, nickname, avatar };
            io.to(room.hostId).emit('joinRequest', joinerData);
            socket.emit('notification', { msg: 'Oda sahibine istek gönderildi...', type: 'info' });
        } else {
            // Oyun LOBBY ise veya oyuncu zaten varsa (reconnect senaryosu basitçe)
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
            const nickname = joinerSocket.handshake.query.nickname || 'Misafir'; 
            // joinRoomHandler içinde nickname'i joinerSocket üzerinden alamıyoruz, 
            // o yüzden joinRoomHandler'ı manuel simüle ediyoruz veya o fonksiyona parametre ekliyoruz.
            // Basitleştirilmiş:
            const newPlayer = { 
                id: joinerId, 
                nickname: 'Yeni Oyuncu', // Socket verisinden almak karmaşıklaştı, basit tutalım
                avatar: '👤',
                hand: [],
                score: 0 
            };
            // joinerSocket'e "yeniden katıl" sinyali gönderelim, böylece doğru verilerle girsin
            joinerSocket.emit('forceJoin', { roomId }); 
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
        // RASTGELE BAŞLANGIÇ
        room.turnIndex = Math.floor(Math.random() * room.players.length); 
        room.unoCallers.clear();
        room.logs = [];
        room.pendingChallenge = null;
        
        room.players.forEach(p => { p.hand = room.deck.splice(0, 7); });

        let first;
        do { first = room.deck.pop(); } while (first.color === 'black');
        
        room.discardPile.push(first);
        room.currentColor = first.color;
        
        addLog(room, "Oyun Başladı! İlk sıra rastgele seçildi.", 'system');
        startTurnTimer(room);
        broadcastGameState(roomId);
    });

    socket.on('chatMessage', ({ message, targetId }) => {
        const roomId = getPlayerRoomId(socket.id);
        if(!roomId) return;
        const room = rooms.get(roomId);
        const sender = room.players.find(p => p.id === socket.id);
        if(!sender) return;

        if (targetId === 'all') {
            addLog(room, message, 'chat', sender.nickname);
        } else {
            // Özel mesaj (DM)
            const target = room.players.find(p => p.id === targetId);
            if (target) {
                // Sadece gönderen ve alan görsün diye log arrayine eklemiyoruz, direkt emitliyoruz
                // Ancak geçmişte kalsın isteniyorsa log yapısı karmaşıklaşır.
                // Basitlik için: Log arrayine 'private' tipinde ekleyelim, client filtrelesin.
                const logEntry = { 
                    type: 'private', 
                    msg: message, 
                    sender: sender.nickname, 
                    to: target.id, // Kime gittiği (ID)
                    toName: target.nickname,
                    fromId: sender.id
                };
                room.logs.push(logEntry);
                if(room.logs.length > 50) room.logs.shift();
            }
        }
        broadcastGameState(roomId);
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

            if (player.hand.length === 1) {
                if (!room.unoCallers.has(player.id)) {
                    addLog(room, `🚨 ${player.nickname} UNO demeyi unuttu! +2 Ceza!`, 'system');
                    drawCards(room, player, 2);
                }
            }
            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} attı: ${formatCardName(card)}`, 'system');
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
        addLog(room, `${room.players[room.turnIndex].nickname} kart çekti.`, 'system');
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
            // Hem bildirim hem ses
            io.to(roomId).emit('notification', { msg: `${player.nickname} UNO dedi!`, type: 'warning' });
            io.to(roomId).emit('playSound', 'uno');
            // Sohbete de düşsün
            addLog(room, `${player.nickname} UNO DEDİ!`, 'system');
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
            addLog(room, `${victim.nickname} +4'ü kabul etti.`, 'system');
            drawCards(room, victim, 4);
            advanceTurn(room); 
        } else {
            const hasColor = attacker.hand.some(c => c.color === oldColor && c.color !== 'black');
            if (hasColor) {
                addLog(room, `⚖️ YAKALANDI! ${attacker.nickname} blöf yapmıştı! (Ceza: 4 Kart)`, 'system');
                drawCards(room, attacker, 4);
                advanceTurn(room);
            } else {
                addLog(room, `⚖️ TEMİZ! ${attacker.nickname} dürüsttü. ${victim.nickname} 6 kart çekiyor!`, 'system');
                drawCards(room, victim, 6);
                advanceTurn(room);
            }
        }
        room.pendingChallenge = null;
        broadcastGameState(roomId);
        startTurnTimer(room);
    });

    socket.on('resetToLobby', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if (!room || room.hostId !== socket.id) return;

        // Odayı sıfırla ama oyuncuları atma
        room.gameState = 'LOBBY';
        room.deck = [];
        room.discardPile = [];
        room.players.forEach(p => {
            p.hand = [];
            p.score = 0; // Puanları sıfırla veya tut (isteğe bağlı, burada sıfırlıyoruz)
            p.hasUno = false;
        });
        room.logs = [];
        room.logs.push({ type: 'system', msg: 'Oda sahibi oyunu sıfırladı. Yeni oyun bekleniyor...' });
        
        broadcastGameState(roomId);
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
                broadcastGameState(roomId);
            }
        }
    });
});

// --- OYUN MANTIĞI FONKSİYONLARI ---

function handleCardEffect(room, card, player, oldColorForChallenge) {
    let skipNext = false;

    if (card.value === 'skip') { 
        skipNext = true; 
        addLog(room, "Sıra atladı!", 'system'); 
    } 
    else if (card.value === 'reverse') {
        room.direction *= -1;
        addLog(room, "Yön değişti!", 'system');
        if (room.players.length === 2) { skipNext = true; } 
    }
    else if (card.value === 'draw2') {
        const next = getNextPlayer(room);
        drawCards(room, next, 2);
        addLog(room, `${next.nickname} +2 yedi!`, 'system');
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
        return; 
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
    room.turnDeadline = Date.now() + 60000;
    
    room.timer = setTimeout(() => {
        const currentPlayer = room.players[room.turnIndex];
        drawCards(room, currentPlayer, 1);
        addLog(room, `${currentPlayer.nickname} süre doldu.`, 'system');
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
        winner: winner.nickname, 
        score: totalScore,
        players: room.players,
        isHost: true // Client kontrol edecek
    });
    // Burada otomatik reset yapmıyoruz, oda sahibinin butonuna bırakıyoruz.
}

function joinRoomHandler(socket, roomId, nickname, avatar) {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error', 'Oda yok.');
    
    socket.join(roomId);
    
    // Eski oyuncu kontrolü (Refresh durumunda)
    const existingIndex = room.players.findIndex(p => p.nickname === nickname);
    if (existingIndex !== -1) {
        // Eski socket ID'yi güncelle
        room.players[existingIndex].id = socket.id;
        // Eğer oyun oynanıyorsa elini koru, lobby ise zaten elde bişi yok
    } else {
        // Tamamen yeni
        room.players.push({ id: socket.id, nickname, avatar, hand: [] });
        addLog(room, `${nickname} katıldı.`, 'system');
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

function addLog(room, msg, type = 'system', sender = '') {
    room.logs.push({ type, msg, sender });
    if(room.logs.length > 50) room.logs.shift(); // Geçmişi biraz daha uzun tutalım
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
            // Logları filtrele: Private mesajlar sadece ilgili kişiye
            const filteredLogs = room.logs.filter(l => {
                if (l.type === 'private') {
                    return l.to === p.id || l.fromId === p.id;
                }
                return true;
            });

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
                myHand: p.hand,
                topCard: room.discardPile[room.discardPile.length-1],
                currentColor: room.currentColor,
                logs: filteredLogs,
                turnOwner: room.players[room.turnIndex] ? room.players[room.turnIndex].nickname : '',
                isMyTurn: room.players[room.turnIndex] ? room.players[room.turnIndex].id === p.id : false,
                turnDeadline: room.turnDeadline,
                pendingChallenge: !!room.pendingChallenge
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('UNO Legend Server Aktif!'));
