// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const TURN_TIME = 60;

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingInterval: 10000,
    pingTimeout: 20000
});

const rooms = new Map();

/* ================= HELPERS ================= */

const uid = () => Math.random().toString(36).slice(2);

function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function createDeck() {
    const colors = ['red','blue','green','yellow'];
    const deck = [];
    colors.forEach(c=>{
        deck.push({c,v:'0',t:'n'});
        for(let i=1;i<=9;i++){
            deck.push({c,v:String(i),t:'n'});
            deck.push({c,v:String(i),t:'n'});
        }
        ['skip','reverse','draw2'].forEach(v=>{
            deck.push({c,v,t:'a'});
            deck.push({c,v,t:'a'});
        });
    });
    for(let i=0;i<4;i++){
        deck.push({c:'black',v:'wild',t:'w'});
        deck.push({c:'black',v:'wild4',t:'w'});
    }
    return shuffle(deck.map(x=>({...x,id:uid()})));
}

function nextTurn(room, skip=1) {
    room.turn = (room.turn + room.dir*skip + room.players.length) % room.players.length;
}

function startTimer(room) {
    clearInterval(room.timer);
    room.deadline = Date.now() + TURN_TIME*1000;
    room.timer = setInterval(()=>{
        if(Date.now() > room.deadline){
            const p = room.players[room.turn];
            draw(room,p,1);
            room.logs.push(`⏱️ ${p.name} süreyi kaçırdı (+1)`);
            nextTurn(room);
            sync(room);
            startTimer(room);
        }
    },1000);
}

function draw(room, player, n) {
    while(n--){
        if(!room.deck.length){
            const top = room.discard.pop();
            room.deck = shuffle(room.discard);
            room.discard = [top];
        }
        player.hand.push(room.deck.pop());
    }
}

function sync(room){
    io.to(room.id).emit('state', {
        players: room.players.map(p=>({
            id:p.id,
            name:p.name,
            count:p.hand.length
        })),
        turn: room.players[room.turn].id,
        top: room.discard.at(-1),
        color: room.color,
        logs: room.logs.slice(-50),
        deadline: room.deadline
    });
}

/* ================= SOCKET ================= */

io.on('connection', socket=>{
    socket.on('create', name=>{
        const id = uid().slice(0,5).toUpperCase();
        const room = {
            id,
            players: [],
            deck: [],
            discard: [],
            turn: 0,
            dir: 1,
            logs: [],
            uno: new Set(),
            timer: null,
            deadline: 0
        };
        rooms.set(id,room);
        socket.emit('created',id);
        socket.join(id);
        room.players.push({id:socket.id,name,hand:[]});
    });

    socket.on('join',(id,name)=>{
        const r = rooms.get(id);
        if(!r) return;
        socket.join(id);
        r.players.push({id:socket.id,name,hand:[]});
        sync(r);
    });

    socket.on('start', id=>{
        const r = rooms.get(id);
        if(!r) return;
        r.deck = createDeck();
        r.players.forEach(p=>p.hand = r.deck.splice(0,7));
        r.turn = Math.floor(Math.random()*r.players.length); // ✅ RANDOM START
        let first;
        do { first = r.deck.pop(); } while(first.c==='black');
        r.discard=[first];
        r.color=first.c;
        r.logs.push('🎮 Oyun başladı');
        startTimer(r);
        sync(r);
    });

    socket.on('play',({id,card,color})=>{
        const r = rooms.get(id);
        if(!r) return;
        const p = r.players[r.turn];
        if(p.id!==socket.id) return;

        const c = p.hand.splice(card,1)[0];
        r.discard.push(c);
        r.color = c.c==='black'?color:c.c;

        // ✅ UNO CEZA
        if(p.hand.length===0 && !r.uno.has(p.id)){
            draw(r,p,2);
            r.logs.push(`🚨 ${p.name} UNO demedi (+2)`);
        }
        r.uno.clear();

        if(c.v==='skip') nextTurn(r,2);
        else if(c.v==='reverse') { r.dir*=-1; nextTurn(r); }
        else if(c.v==='draw2'){ nextTurn(r); draw(r,r.players[r.turn],2); nextTurn(r); }
        else nextTurn(r);

        sync(r);
        startTimer(r);
    });

    socket.on('uno',id=>{
        const r = rooms.get(id);
        if(!r) return;
        r.uno.add(socket.id);
        io.to(id).emit('notify','UNO!');
    });

    socket.on('chat',({id,to,msg})=>{
        io.to(to||id).emit('chat',{
            from:socket.id,
            msg
        });
    });

    socket.on('disconnect',()=>{
        rooms.forEach(r=>{
            r.players = r.players.filter(p=>p.id!==socket.id);
            if(!r.players.length){
                clearInterval(r.timer);
                rooms.delete(r.id);
            }
        });
    });
});

server.listen(3000,()=>console.log('UNO Server ✅'));
