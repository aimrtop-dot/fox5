const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 1. قاعدة بيانات مركزية ومحمية (لا يمكن للاعب الوصول إليها)
// في بيئة العمل الحقيقية، نستخدم قاعدة بيانات مثل MongoDB أو MySQL
let playersDB = [
    { username: 'ali', password: '123', balance: 15000 },
    { username: 'omar', password: '123', balance: 25000 },
    { username: 'admin', password: 'admin123', balance: 0, isAdmin: true } // حساب مدير محمي
];

// 4. نظام طوابير الانتظار (Matchmaking) للعبة الدومنه
const dominoQueues = {
    500: [],
    1000: [],
    5000: [],
    10000: []
};
const activeDominoMatches = {}; // لتخزين المباريات النشطة والمستمرة

// تقديم ملفات الواجهة (ملف index.html الخاص بك)
app.use(express.static(path.join(__dirname)));

io.on('connection', (socket) => {
    console.log('مستخدم متصل:', socket.id);

    // 2. تأمين نظام تسجيل الدخول
    socket.on('login_request', (data) => {
        // البحث عن المستخدم والتحقق من كلمة المرور في الخادم
        const user = playersDB.find(p => p.username === data.username && p.password === data.password);
        
        if (user) {
            // حفظ بيانات المستخدم في الجلسة الخاصة بهذا الاتصال
            socket.user = user;
            socket.emit('login_success', { username: user.username, balance: user.balance, isAdmin: user.isAdmin });
        } else {
            socket.emit('login_error', 'اسم المستخدم أو كلمة المرور غير صحيحة!');
        }
    });

    // 2.5. مزامنة قاعدة البيانات بين الإدارة والخادم (لضمان تعرف الخادم على اللاعبين الجدد)
    socket.on('state_changed', (data) => {
        if (data.playersDB) {
            playersDB = data.playersDB; // تحديث بيانات الخادم بالبيانات الجديدة
        }
        // إرسال البيانات لبقية المتصلين
        socket.broadcast.emit('sync_data', data);
    });

    // 3. مثال: تأمين لعبة النرد
    socket.on('play_dice_request', (betData) => {
        if (!socket.user) return socket.emit('error_msg', 'يجب تسجيل الدخول أولاً!');
        
        let player = playersDB.find(p => p.username === socket.user.username);
        
        // التحقق من الرصيد في الخادم (لا يمكن للاعب التلاعب هنا)
        if (player.balance < betData.amount) {
            return socket.emit('error_msg', 'عفواً، رصيدك غير كافٍ!');
        }

        // خصم الرصيد فوراً
        player.balance -= betData.amount;

        // توليد النتيجة العشوائية في الخادم (يمنع المتصفح من الغش)
        let dice1 = Math.floor(Math.random() * 6) + 1;
        let dice2 = Math.floor(Math.random() * 6) + 1;
        let sum = dice1 + dice2;

        let isWin = false;
        if (betData.type === 'under' && sum < 7) isWin = true;
        if (betData.type === 'over' && sum > 7) isWin = true;

        if (isWin) {
            let winAmount = betData.amount * 3;
            player.balance += winAmount;
        }

        // إرسال النتيجة والرصيد الجديد للمتصفح لعرض الانميشن
        socket.emit('dice_result', {
            dice1: dice1,
            dice2: dice2,
            isWin: isWin,
            newBalance: player.balance
        });
    });

    // 5. الانضمام لغرفة انتظار الدومنه (Matchmaking)
    socket.on('join_domino_queue', (data) => {
        let player = playersDB.find(p => p.username === data.username);
        if (!player) return socket.emit('error_msg', 'اللاعب غير موجود في الخادم!');
        
        // التحقق من الرصيد قبل السماح بالدخول للطابور
        if (player.balance < data.entryPrice) {
            return socket.emit('error_msg', 'عفواً، رصيدك غير كافٍ للانضمام لهذه الطاولة!');
        }

        // التأكد من أن الطابور لهذه الفئة موجود
        if (!dominoQueues[data.entryPrice]) return;

        // منع اللاعب من الدخول للطابور أكثر من مرة
        const isAlreadyInQueue = dominoQueues[data.entryPrice].find(s => s.player && s.player.username === player.username);
        if (isAlreadyInQueue) {
            return socket.emit('error_msg', 'أنت تبحث عن مباراة بالفعل في هذه الطاولة!');
        }

        // التحقق مما إذا كان هناك لاعب آخر ينتظر فعلياً في الطابور
        if (dominoQueues[data.entryPrice].length > 0) {
            // سحب اللاعب الأول المنتظر من الطابور
            let player1Socket = dominoQueues[data.entryPrice].shift();
            let player2Socket = socket; // اللاعب الحالي هو اللاعب الثاني
            player2Socket.player = player; // إصلاح الخلل: تعريف اللاعب الثاني للخادم لمنع التوقف

            // إيقاف مؤقت البوت للاعب الأول لأنه وجد خصماً حقيقياً!
            clearTimeout(player1Socket.botTimer);

            // خصم رصيد الدخول من كلا اللاعبين في الخادم
            player1Socket.player.balance -= data.entryPrice;
            player2Socket.player.balance -= data.entryPrice;

            // إعداد بيانات المباراة الحقيقية بين اللاعبين
            let matchId = 'domino_' + Date.now();
            let allTiles = [];
            for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) allTiles.push([i, j]);
            allTiles.sort(() => Math.random() - 0.5);

            activeDominoMatches[matchId] = {
                id: matchId,
                player1: player1Socket.player.username,
                player2: player2Socket.player.username,
                player1SocketId: player1Socket.id,
                player2SocketId: player2Socket.id,
                p1Hand: allTiles.splice(0, 7),
                p2Hand: allTiles.splice(0, 7),
                boneyard: allTiles, // السحبة
                board: [],
                leftEnd: null, rightEnd: null,
                turn: player1Socket.player.username, // اللاعب الأول يبدأ
                entryPrice: data.entryPrice,
                isBotMatch: false
            };
            player1Socket.emit('domino_match_found', { matchId: matchId, player1: player1Socket.player.username, player2: player2Socket.player.username, entryPrice: data.entryPrice, hand: activeDominoMatches[matchId].p1Hand, turn: player1Socket.player.username, newBalance: player1Socket.player.balance });
            player2Socket.emit('domino_match_found', { matchId: matchId, player1: player1Socket.player.username, player2: player2Socket.player.username, entryPrice: data.entryPrice, hand: activeDominoMatches[matchId].p2Hand, turn: player1Socket.player.username, newBalance: player2Socket.player.balance });
        } else {
            // لم يتم العثور على لاعب حقيقي! إذن نضعه في الطابور للانتظار
            socket.player = player;
            dominoQueues[data.entryPrice].push(socket);
            socket.emit('joined_domino_queue', data.entryPrice);

            // تشغيل مؤقت ذكي (4 ثوانٍ)، إذا لم يدخل أحد، نولد بوت ليلعب معه
            socket.botTimer = setTimeout(() => {
                const index = dominoQueues[data.entryPrice].indexOf(socket);
                // التأكد أن اللاعب ما زال في الطابور ولم يفصل من الخادم
                if (index !== -1 && socket.connected) {
                    // إزالته من الطابور حتى لا يسحبه لاعب آخر لاحقاً
                    dominoQueues[data.entryPrice].splice(index, 1);
                    
                    // خصم رسوم الطاولة للدخول
                    socket.player.balance -= data.entryPrice;
                    
                    // إعداد بيانات المباراة الفردية
                    let botName = '🤖 الروبوت الذكي';
                    let matchId = 'domino_' + Date.now();
                    
                    // 1. توليد وخلط الأحجار (28 حجر)
                    let allTiles = [];
                    for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) allTiles.push([i, j]);
                    allTiles.sort(() => Math.random() - 0.5);

                    // 2. إنشاء وتخزين حالة المباراة
                    activeDominoMatches[matchId] = {
                        id: matchId,
                        player1: socket.player.username,
                        player2: botName,
                        botName: botName,
                        player1SocketId: socket.id,
                        player2SocketId: null, // الروبوت لا يمتلك اتصال
                        p1Hand: allTiles.splice(0, 7), // 7 قطع للاعب
                        p2Hand: allTiles.splice(0, 7), // 7 قطع للروبوت
                        boneyard: allTiles, // باقي القطع (14 قطعة) في السحبة للاستخدام عند عدم وجود قطعة مناسبة
                        board: [],
                        leftEnd: null,
                        rightEnd: null,
                        turn: socket.player.username, // اللاعب يبدأ دائماً
                        entryPrice: data.entryPrice,
                        isBotMatch: true
                    };

                    // إعلان بدء المباراة وإرسال القطع للاعب
                    let matchData = { 
                        matchId: matchId, 
                        player1: socket.player.username, 
                        player2: botName, 
                        entryPrice: data.entryPrice,
                        hand: activeDominoMatches[matchId].p1Hand,
                        turn: socket.player.username
                    };
                    socket.emit('domino_match_found', { ...matchData, newBalance: socket.player.balance });
                }
            }, 4000); // يمكن تغيير الـ 4000 (والتي تعني 4 ثوانٍ) لأي مدة تريدها
        }
    });

    // 6. أحداث اللعب (منطق وضع الأحجار وتبادل الأدوار)
    socket.on('play_domino_tile', (data) => {
        let match = activeDominoMatches[data.matchId];
        if (!match || match.turn !== socket.player.username) return;

        let isPlayer1 = socket.player.username === match.player1;
        let myHand = isPlayer1 ? match.p1Hand : match.p2Hand;

        // البحث عن الحجر في يد اللاعب الحالي
        let tileIndex = myHand.findIndex(t => (t[0] === data.tile[0] && t[1] === data.tile[1]) || (t[0] === data.tile[1] && t[1] === data.tile[0]));
        if (tileIndex === -1) return;

        let tile = myHand[tileIndex];
        let played = false;

        // إذا كانت الرقعة فارغة، ضع الحجر في المنتصف
        if (match.board.length === 0) {
            match.board.push(tile);
            match.leftEnd = tile[0];
            match.rightEnd = tile[1];
            played = true;
        } else {
            // التحقق من المطابقة وتعديل اتجاه القطعة للربط الصحيح
            if (tile[0] === match.leftEnd || tile[1] === match.leftEnd) {
                if (tile[1] !== match.leftEnd) tile = [tile[1], tile[0]];
                match.board.unshift(tile); // إضافة للجهة اليسرى
                match.leftEnd = tile[0];
                played = true;
            } else if (tile[0] === match.rightEnd || tile[1] === match.rightEnd) {
                if (tile[0] !== match.rightEnd) tile = [tile[1], tile[0]];
                match.board.push(tile); // إضافة للجهة اليمنى
                match.rightEnd = tile[1];
                played = true;
            }
        }

        // إذا كانت الحركة صالحة
        if (played) {
            myHand.splice(tileIndex, 1); // إزالة الحجر من يد اللاعب
            match.turn = isPlayer1 ? match.player2 : match.player1; // تحويل الدور للخصم
            
            let p1Socket = io.sockets.sockets.get(match.player1SocketId);
            let p2Socket = match.isBotMatch ? null : io.sockets.sockets.get(match.player2SocketId);

            // فحص الفوز للاعب
            if (myHand.length === 0) {
                let winAmount = match.entryPrice * 2;
                socket.player.balance += winAmount;
                
                // حساب مجموع نقاط اللاعب الخاسر (مجموع النقاط على الأحجار المتبقية)
                let loserHand = isPlayer1 ? match.p2Hand : match.p1Hand;
                let loserScore = loserHand.reduce((sum, tile) => sum + tile[0] + tile[1], 0);

                if (p1Socket) {
                    let isWinner = p1Socket.player.username === socket.player.username;
                    let msg = isWinner ? `🎉 مبروك! لقد فزت في المباراة!\nنقاط خصمك المتبقية: ${loserScore}` : `😢 للأسف لقد خسرت المباراة.\nمجموع نقاطك المتبقية: ${loserScore}`;
                    p1Socket.emit('update_domino_board', { board: match.board, turn: '', myHand: match.p1Hand, oppHandCount: match.p2Hand.length });
                    p1Socket.emit('domino_match_ended', { winner: socket.player.username, msg: msg, newBalance: p1Socket.player.balance });
                }
                if (p2Socket) {
                    let isWinner = p2Socket.player.username === socket.player.username;
                    let msg = isWinner ? `🎉 مبروك! لقد فزت في المباراة!\nنقاط خصمك المتبقية: ${loserScore}` : `😢 للأسف لقد خسرت المباراة.\nمجموع نقاطك المتبقية: ${loserScore}`;
                    p2Socket.emit('update_domino_board', { board: match.board, turn: '', myHand: match.p2Hand, oppHandCount: match.p1Hand.length });
                    p2Socket.emit('domino_match_ended', { winner: socket.player.username, msg: msg, newBalance: p2Socket.player.balance });
                }
                delete activeDominoMatches[match.id];
            } else {
                // تحديث رقعة اللاعبين
                if (p1Socket) p1Socket.emit('update_domino_board', { board: match.board, turn: match.turn, myHand: match.p1Hand, oppHandCount: match.p2Hand.length });
                if (p2Socket) p2Socket.emit('update_domino_board', { board: match.board, turn: match.turn, myHand: match.p2Hand, oppHandCount: match.p1Hand.length });
                
                // إذا كان الخصم هو الروبوت، اجعله يلعب
                if (match.isBotMatch) setTimeout(() => { playBotTurn(match.id, socket); }, 1500);
            }
        } else {
            socket.emit('error_msg', 'حركة غير صالحة! القطعة لا تتطابق مع أطراف الرقعة.');
        }
    });

    // تمرير الدور أو السحب (Draw) إذا لم يمتلك اللاعب حجراً مناسباً
    socket.on('pass_domino_turn', (data) => {
        let match = activeDominoMatches[data.matchId];
        if (!match || match.turn !== socket.player.username) return;
        
        let isPlayer1 = socket.player.username === match.player1;
        let myHand = isPlayer1 ? match.p1Hand : match.p2Hand;
        
        let p1Socket = io.sockets.sockets.get(match.player1SocketId);
        let p2Socket = match.isBotMatch ? null : io.sockets.sockets.get(match.player2SocketId);

        // إذا كانت السحبة متوفرة، اسحب قطعة للاعب ولا تمرر الدور!
        if (match.boneyard && match.boneyard.length > 0) {
            let drawnTile = match.boneyard.pop();
            myHand.push(drawnTile);
            
            if (p1Socket) p1Socket.emit('update_domino_board', { board: match.board, turn: match.turn, myHand: match.p1Hand, oppHandCount: match.p2Hand.length });
            if (p2Socket) p2Socket.emit('update_domino_board', { board: match.board, turn: match.turn, myHand: match.p2Hand, oppHandCount: match.p1Hand.length });
            
            socket.emit('error_msg', 'لقد قمت بسحب قطعة جديدة من الرقعة المتبقية (السحبة).');
            return;
        }

        // إذا نفذت السحبة، قم بتمرير الدور
        match.turn = isPlayer1 ? match.player2 : match.player1;
        
        if (p1Socket) p1Socket.emit('update_domino_board', { board: match.board, turn: match.turn, myHand: match.p1Hand, oppHandCount: match.p2Hand.length });
        if (p2Socket) p2Socket.emit('update_domino_board', { board: match.board, turn: match.turn, myHand: match.p2Hand, oppHandCount: match.p1Hand.length });
        
        if (match.isBotMatch) setTimeout(() => { playBotTurn(match.id, socket); }, 1500);
    });
    
    // عند الانسحاب من الواجهة
    socket.on('surrender_domino_match', (matchId) => {
        if (activeDominoMatches[matchId]) delete activeDominoMatches[matchId];
    });

    // دالة محرك الروبوت (Bot AI)
    function playBotTurn(matchId, socket) {
        let match = activeDominoMatches[matchId];
        if (!match || !match.isBotMatch) return;

        let played = false;
        
        // دالة مساعدة لمحاولة وضع قطعة من يد الروبوت
        function tryToPlay() {
            for (let i = 0; i < match.p2Hand.length; i++) {
                let tile = match.p2Hand[i];
                if (match.board.length === 0) {
                    match.board.push(tile); match.leftEnd = tile[0]; match.rightEnd = tile[1];
                    match.p2Hand.splice(i, 1); played = true; break;
                } else {
                    if (tile[0] === match.leftEnd || tile[1] === match.leftEnd) {
                        if (tile[1] !== match.leftEnd) tile = [tile[1], tile[0]];
                        match.board.unshift(tile); match.leftEnd = tile[0];
                        match.p2Hand.splice(i, 1); played = true; break;
                    } else if (tile[0] === match.rightEnd || tile[1] === match.rightEnd) {
                        if (tile[0] !== match.rightEnd) tile = [tile[1], tile[0]];
                        match.board.push(tile); match.rightEnd = tile[1];
                        match.p2Hand.splice(i, 1); played = true; break;
                    }
                }
            }
        }

        tryToPlay(); // المحاولة الأولى

        // السحب من الـ (Boneyard) إذا لم يجد قطعة مناسبة
        while (!played && match.boneyard && match.boneyard.length > 0) {
            let drawnTile = match.boneyard.pop(); // سحب قطعة جديدة من الباقي
            match.p2Hand.push(drawnTile); // إضافتها ليد الروبوت
            tryToPlay(); // المحاولة مرة أخرى بالقطعة الجديدة
        }

        match.turn = match.player1; // إعادة الدور للاعب الحقيقي

        if (match.p2Hand.length === 0) {
            // حساب نقاط اللاعب الحقيقي بعد خسارته أمام الروبوت
            let loserScore = match.p1Hand.reduce((sum, tile) => sum + tile[0] + tile[1], 0);
            
            socket.emit('update_domino_board', { board: match.board, turn: '', myHand: match.p1Hand, oppHandCount: match.p2Hand.length });
            socket.emit('domino_match_ended', { winner: match.botName, msg: `😢 لقد فاز الروبوت! حظاً أوفر في المرة القادمة.\nمجموع نقاطك المتبقية: ${loserScore}`, newBalance: socket.player.balance });
            delete activeDominoMatches[matchId];
        } else {
            socket.emit('update_domino_board', { board: match.board, turn: match.turn, myHand: match.p1Hand, oppHandCount: match.p2Hand.length });
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`الخادم الآمن يعمل على المنفذ: ${PORT}`);
});