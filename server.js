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

    socket.on('createRoom', ({ nickname, avatar, rules }) => {
        const roomId = generateRoomId();
        const room = {
            id: roomId,
            name: `${nickname}'in Odası`,
            hostId: socket.id,
            players: [],
            gameState: 'LOBBY', // LOBBY, PLAYING, ROUND_OVER
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
            currentColor: null,
            logs: [],
            unoCallers: new Set(),
            pendingChallenge: null,
            timer: null,
            // EV KURALLARI (Varsayılanlar)
            settings: rules || { stacking: false, sevenZero: false, jumpIn: false, forcePlay: true }
        };
        rooms.set(roomId, room);
        joinRoomHandler(socket, roomId, nickname, avatar);
    });

    socket.on('joinRoom', ({ roomId, nickname, avatar }) => {
        const room = rooms.get(roomId);
        if (!room) return socket.emit('error', 'Oda bulunamadı.');
        
        // Late Join (İzleyici veya Oyuncu)
        if (room.gameState !== 'LOBBY') {
             // Basitlik için oyun sırasında giren izleyici olsun
             socket.join(roomId);
             socket.emit('error', 'Oyun devam ediyor, şu an izleyicisin.');
             // Tamamlanmış Late Join mantığı bir önceki kodda vardı, burada kural odaklı gidiyoruz.
             return;
        }
        joinRoomHandler(socket, roomId, nickname, avatar);
    });

    socket.on('startGame', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        
        if (!room || room.hostId !== socket.id) return;
        if (room.players.length < 2) {
            socket.emit('error', 'En az 2 oyuncu gerekli!');
            return;
        }

        startRound(room);
    });

    socket.on('playCard', ({ cardIndex, chosenColor }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);

        if (room.players[room.turnIndex].id !== socket.id) return;
        if (room.pendingChallenge) return; // Meydan okuma beklenirken oynanamaz

        const card = player.hand[cardIndex];
        const top = room.discardPile[room.discardPile.length - 1];
        
        // --- RESMİ KURAL DOĞRULAMA ---
        let isValid = false;
        
        // Jokerler her zaman oynanır
        if (card.color === 'black') isValid = true;
        // Renk Eşleşmesi
        else if (card.color === room.currentColor) isValid = true;
        // Sayı/Sembol Eşleşmesi
        else if (card.value === top.value) isValid = true;

        if (isValid) {
            resetTurnTimer(room);
            
            // +4 Blöf Kontrolü için önceki rengi sakla
            const colorBeforeWild = room.currentColor;

            // Kartı oyna
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            
            // Rengi güncelle
            room.currentColor = (card.color === 'black') ? chosenColor : card.color;

            // UNO Kontrolü (Otomatik UNO yok, basmazsa ceza yer)
            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} attı: ${formatCardName(card)}`);
            
            // Efektleri Uygula
            handleCardEffect(room, card, player, colorBeforeWild);
        } else {
            socket.emit('error', 'Bu kartı oynayamazsın!');
        }
    });

    socket.on('drawCard', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if (!room) return;
        if (room.players[room.turnIndex].id !== socket.id) return;

        resetTurnTimer(room);
        drawCards(room, room.players[room.turnIndex], 1);
        addLog(room, `${room.players[room.turnIndex].nickname} kart çekti.`);
        
        // Resmi Kural: Çekilen kart oynanabilirse oynayabilir, değilse sıra geçer.
        // Basitlik için: Çekince sıra geçer (House Rule: Force Play değilse)
        // Eğer Force Play açıksa ve oynanabilirse oynatılabilir (Bu detay client-side logic gerektirir)
        // Biz standart "Çek ve Geç" yapalım.
        
        advanceTurn(room);
        broadcastGameState(roomId);
        startTurnTimer(room);
    });

    socket.on('callUno', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        // Sadece 2 kartı varken (biri atılacak) UNO diyebilir.
        if (player.hand.length <= 2) {
            room.unoCallers.add(player.id);
            io.to(roomId).emit('notification', { msg: `${player.nickname} UNO dedi!`, type: 'warning' });
            io.to(roomId).emit('playSound', 'uno');
            broadcastGameState(roomId);
        }
    });

    // --- +4 MEYDAN OKUMA (Challenge) ---
    socket.on('challengeDecision', ({ decision }) => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room || !room.pendingChallenge) return;

        const { victimId, attackerId, oldColor } = room.pendingChallenge;
        if (socket.id !== victimId) return;

        const attacker = room.players.find(p => p.id === attackerId);
        const victim = room.players.find(p => p.id === victimId);

        if (decision === 'accept') {
            addLog(room, `${victim.nickname} +4'ü kabul etti.`);
            drawCards(room, victim, 4);
            advanceTurn(room); // Sıra victim'den sonrakine geçer
        } else {
            // Blöf Kontrolü: Attacker'ın elinde ESKİ renkten kart var mı? (Wild hariç)
            const hasColor = attacker.hand.some(c => c.color === oldColor && c.color !== 'black');
            
            if (hasColor) {
                // SUÇLU: Attacker 4 kart çeker.
                addLog(room, `⚖️ YAKALANDI! ${attacker.nickname} blöf yapmıştı! (Ceza: 4 Kart)`);
                drawCards(room, attacker, 4);
                // Victim kurtulur, sıra victim'de kalır (veya geçer mi? Kural: Victim oynamaz, sadece kart çekmez)
                // Orijinal kural: Next player plays. Victim kart çekmediği için avantajlıdır ama sırası yanar mı?
                // Wikipedia: "If successful, the player who played the Wild Draw 4 must draw the 4 cards instead."
                // "The play continues from the player after the challenged player." -> Sıra yine geçer.
                advanceTurn(room);
            } else {
                // SUÇSUZ: Victim 6 kart çeker.
                addLog(room, `⚖️ TEMİZ! ${attacker.nickname} dürüsttü. ${victim.nickname} 6 kart çekiyor!`);
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
                broadcastGameState(roomId);
            }
        }
    });
});

// --- OYUN MOTORU ---

function startRound(room) {
    room.gameState = 'PLAYING';
    room.deck = createDeck();
    room.discardPile = [];
    room.direction = 1;
    room.turnIndex = 0;
    room.unoCallers.clear();
    room.pendingChallenge = null;
    
    // Puanları sıfırlama (İlk maçsa)
    room.players.forEach(p => { 
        if(p.totalScore === undefined) p.totalScore = 0;
        p.hand = room.deck.splice(0, 7); 
    });

    // İlk kart aç (Joker olmamalı)
    let first;
    do { first = room.deck.pop(); } while (first.color === 'black');
    
    room.discardPile.push(first);
    room.currentColor = first.color;
    
    addLog(room, "Tur Başladı! Hedef 500 Puan.");
    startTurnTimer(room);
    broadcastGameState(room.id);
}

function handleCardEffect(room, card, player, oldColor) {
    let skipNext = false;

    if (card.value === 'skip') {
        skipNext = true;
        addLog(room, "Sıra atladı!");
    }
    else if (card.value === 'reverse') {
        room.direction *= -1;
        addLog(room, "Yön değişti!");
        if (room.players.length === 2) {
            // 2 Kişilik Kural: Reverse = Skip
            skipNext = true;
            addLog(room, "2 Kişi: Yön Değiştir = Atla");
        }
    }
    else if (card.value === 'draw2') {
        const next = getNextPlayer(room);
        drawCards(room, next, 2);
        addLog(room, `${next.nickname} +2 yedi!`);
        skipNext = true; // +2 yiyen oynayamaz
    }
    else if (card.value === 'wild4') {
        const nextIdx = getNextPlayerIndex(room);
        const nextPlayer = room.players[nextIdx];
        
        // Meydan Okuma Başlat
        room.pendingChallenge = { 
            attackerId: player.id, 
            victimId: nextPlayer.id, 
            oldColor: oldColor 
        };
        
        io.to(nextPlayer.id).emit('challengePrompt', { attacker: player.nickname });
        broadcastGameState(room.id);
        return; // Dur ve yanıt bekle
    }

    // EL BİTTİ Mİ?
    if (player.hand.length === 0) {
        endRound(room, player);
        return;
    }

    advanceTurn(room);
    if (skipNext) advanceTurn(room);
    broadcastGameState(room.id);
    startTurnTimer(room);
}

function endRound(room, winner) {
    if(room.timer) clearTimeout(room.timer);
    
    // Puan Hesapla
    let roundScore = 0;
    room.players.forEach(p => {
        p.hand.forEach(c => roundScore += c.score);
    });
    
    winner.totalScore += roundScore;
    
    if (winner.totalScore >= 500) {
        // MAÇ BİTTİ
        io.to(room.id).emit('gameOver', { 
            winner: winner.nickname, 
            score: winner.totalScore,
            players: room.players,
            isMatchOver: true
        });
        rooms.delete(room.id);
    } else {
        // TUR BİTTİ
        io.to(room.id).emit('gameOver', { 
            winner: winner.nickname, 
            score: roundScore,
            totalScore: winner.totalScore,
            players: room.players,
            isMatchOver: false
        });
        
        // 10 saniye sonra yeni tur
        setTimeout(() => {
            if(rooms.has(room.id)) startRound(room);
        }, 10000);
    }
}

function joinRoomHandler(socket, roomId, nickname, avatar) {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error', 'Oda yok.');
    socket.join(roomId);
    const existing = room.players.find(p => p.id === socket.id);
    if(!existing) {
        room.players.push({ id: socket.id, nickname, avatar, hand: [], totalScore: 0 });
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

function addLog(room, msg) {
    room.logs.push(msg);
    if(room.logs.length > 6) room.logs.shift();
}

function formatCardName(c) {
    if(c.color === 'black') return c.value === 'wild' ? 'Joker' : '+4 Joker';
    return `${c.color.toUpperCase()} ${c.value}`;
}

function startTurnTimer(room) {
    if(room.timer) clearTimeout(room.timer);
    room.turnDeadline = Date.now() + 60000;
    
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

function broadcastGameState(roomId) {
    const room = rooms.get(roomId);
    if(!room) return;

    room.players.forEach(p => {
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
                    hasUno: room.unoCallers.has(pl.id),
                    totalScore: pl.totalScore
                })),
                myHand: p.hand,
                topCard: room.discardPile[room.discardPile.length-1],
                currentColor: room.currentColor,
                logs: room.logs,
                turnOwner: room.players[room.turnIndex].nickname,
                isMyTurn: room.players[room.turnIndex].id === p.id,
                turnDeadline: room.turnDeadline
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('UNO REFORGED SERVER READY'));
