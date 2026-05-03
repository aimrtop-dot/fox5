const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 1. قاعدة بيانات مركزية ومحمية داخل ملف دائم
const dbPath = path.join(__dirname, 'database.json');
let playersDB = [];
let allRounds = [];

// تحميل البيانات من الملف لضمان عدم ضياعها عند إعادة التشغيل
if (fs.existsSync(dbPath)) {
    const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    playersDB = data.playersDB || [];
    allRounds = data.allRounds || [];
} else {
    playersDB = [
        { username: 'ali', password: '123', balance: 15000 },
        { username: 'omar', password: '123', balance: 25000 },
        { username: 'admin', password: 'admin123', balance: 0, isAdmin: true }
    ];
    fs.writeFileSync(dbPath, JSON.stringify({ playersDB, allRounds }));
}

function saveDatabase() {
    fs.writeFileSync(dbPath, JSON.stringify({ playersDB, allRounds }));
}

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

    // إرسال البيانات فوراً للهاتف الجديد ليتعرف على الأرصدة والحسابات الجديدة
    socket.emit('sync_data', { playersDB: playersDB, allRounds: allRounds });

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
        if (data.allRounds) {
            allRounds = data.allRounds;
        }
        saveDatabase(); // حفظ التعديلات في الملف الدائم
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
        
        saveDatabase();

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
            saveDatabase();

            // إعداد بيانات المباراة الحقيقية بين اللاعبين
            let matchId = 'domino_' + Date.now();
            let allTiles = [];
            for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) allTiles.push([i, j]);
            allTiles.sort(() => Math.random() - 0.5);

            let p1Hand = allTiles.splice(0, 7);
            let p2Hand = allTiles.splice(0, 7);

            // تحديد من يبدأ حسب القوانين العالمية (صاحب الدبل الأعلى)
            let startingTurn = player1Socket.player.username;
            let foundDouble = false;
            for (let i = 6; i >= 0; i--) {
                if (p1Hand.some(t => t[0] === i && t[1] === i)) { startingTurn = player1Socket.player.username; foundDouble = true; break; }
                if (p2Hand.some(t => t[0] === i && t[1] === i)) { startingTurn = player2Socket.player.username; foundDouble = true; break; }
            }
            if (!foundDouble) {
                let max1 = Math.max(...p1Hand.map(t => t[0] + t[1]));
                let max2 = Math.max(...p2Hand.map(t => t[0] + t[1]));
                startingTurn = max1 >= max2 ? player1Socket.player.username : player2Socket.player.username;
            }

            activeDominoMatches[matchId] = {
                id: matchId,
                player1: player1Socket.player.username,
                player2: player2Socket.player.username,
                player1SocketId: player1Socket.id,
                player2SocketId: player2Socket.id,
                p1Hand: p1Hand,
                p2Hand: p2Hand,
                boneyard: allTiles, // السحبة
                board: [],
                leftEnd: null, rightEnd: null,
                turn: startingTurn, // البداية حسب القوانين
                entryPrice: data.entryPrice,
                isBotMatch: false,
                consecutivePasses: 0
            };
            player1Socket.emit('domino_match_found', { matchId: matchId, player1: player1Socket.player.username, player2: player2Socket.player.username, entryPrice: data.entryPrice, hand: activeDominoMatches[matchId].p1Hand, turn: startingTurn, newBalance: player1Socket.player.balance });
            player2Socket.emit('domino_match_found', { matchId: matchId, player1: player1Socket.player.username, player2: player2Socket.player.username, entryPrice: data.entryPrice, hand: activeDominoMatches[matchId].p2Hand, turn: startingTurn, newBalance: player2Socket.player.balance });
            startTurnTimer(matchId); // بدء المؤقت عند بداية المباراة
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
                    saveDatabase();
                    
                    // إعداد بيانات المباراة الفردية
                    let botName = '🤖 الروبوت الذكي';
                    let matchId = 'domino_' + Date.now();
                    
                    // 1. توليد وخلط الأحجار (28 حجر)
                    let allTiles = [];
                    for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) allTiles.push([i, j]);
                    allTiles.sort(() => Math.random() - 0.5);

                    let p1Hand = allTiles.splice(0, 7);
                    let p2Hand = allTiles.splice(0, 7);

                    // تحديد من يبدأ حسب القوانين العالمية
                    let startingTurn = socket.player.username;
                    let foundDouble = false;
                    for (let i = 6; i >= 0; i--) {
                        if (p1Hand.some(t => t[0] === i && t[1] === i)) { startingTurn = socket.player.username; foundDouble = true; break; }
                        if (p2Hand.some(t => t[0] === i && t[1] === i)) { startingTurn = botName; foundDouble = true; break; }
                    }
                    if (!foundDouble) {
                        let max1 = Math.max(...p1Hand.map(t => t[0] + t[1]));
                        let max2 = Math.max(...p2Hand.map(t => t[0] + t[1]));
                        startingTurn = max1 >= max2 ? socket.player.username : botName;
                    }

                    // 2. إنشاء وتخزين حالة المباراة
                    activeDominoMatches[matchId] = {
                        id: matchId,
                        player1: socket.player.username,
                        player2: botName,
                        botName: botName,
                        player1SocketId: socket.id,
                        player2SocketId: null, // الروبوت لا يمتلك اتصال
                        p1Hand: p1Hand, // 7 قطع للاعب
                        p2Hand: p2Hand, // 7 قطع للروبوت
                        boneyard: allTiles, // باقي القطع (14 قطعة) في السحبة للاستخدام عند عدم وجود قطعة مناسبة
                        board: [],
                        leftEnd: null,
                        rightEnd: null,
                        turn: startingTurn, // البداية حسب القوانين
                        entryPrice: data.entryPrice,
                        isBotMatch: true,
                        consecutivePasses: 0
                    };

                    // إعلان بدء المباراة وإرسال القطع للاعب
                    let matchData = { 
                        matchId: matchId, 
                        player1: socket.player.username, 
                        player2: botName, 
                        entryPrice: data.entryPrice,
                        hand: activeDominoMatches[matchId].p1Hand,
                        turn: startingTurn
                    };
                    socket.emit('domino_match_found', { ...matchData, newBalance: socket.player.balance });

                    // إذا كان الدور للروبوت، اجعله يلعب فوراً
                    if (startingTurn === botName) {
                        setTimeout(() => { playBotTurn(matchId, socket); }, 1500);
                    } else {
                        startTurnTimer(matchId); // بدء المؤقت للاعب إذا كان هو البادئ
                    }
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
            let canPlayLeft = (tile[0] === match.leftEnd || tile[1] === match.leftEnd);
            let canPlayRight = (tile[0] === match.rightEnd || tile[1] === match.rightEnd);

            // إذا كان الحجر يتطابق مع الجهتين ولم يحدد اللاعب الجهة بعد، نطلب منه التحديد
            if (canPlayLeft && canPlayRight && !data.side) {
                return socket.emit('choose_domino_side', data.tile);
            }

            // إذا اختار اللاعب جهة معينة، نقوم بتعطيل الجهة الأخرى برمجياً
            if (data.side === 'left') canPlayRight = false;
            if (data.side === 'right') canPlayLeft = false;

            // التحقق من المطابقة وتعديل اتجاه القطعة للربط الصحيح
            if (canPlayLeft) {
                if (tile[1] !== match.leftEnd) tile = [tile[1], tile[0]];
                match.board.unshift(tile); // إضافة للجهة اليسرى
                match.leftEnd = tile[0];
                played = true;
            } else if (canPlayRight) {
                if (tile[0] !== match.rightEnd) tile = [tile[1], tile[0]];
                match.board.push(tile); // إضافة للجهة اليمنى
                match.rightEnd = tile[1];
                played = true;
            }
        }

        // إذا كانت الحركة صالحة
        if (played) {
            if (match.turnTimer) clearTimeout(match.turnTimer); // إيقاف مؤقت اللاعب لأنه لعب بنجاح
            match.consecutivePasses = 0; // تصفير العداد لأن اللاعب قام بحركة صحيحة
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
                saveDatabase();
            } else {
                // تحديث رقعة اللاعبين
                if (p1Socket) p1Socket.emit('update_domino_board', { board: match.board, turn: match.turn, myHand: match.p1Hand, oppHandCount: match.p2Hand.length });
                if (p2Socket) p2Socket.emit('update_domino_board', { board: match.board, turn: match.turn, myHand: match.p2Hand, oppHandCount: match.p1Hand.length });
                
                // إذا كان الخصم هو الروبوت، اجعله يلعب
                if (match.isBotMatch) setTimeout(() => { playBotTurn(match.id, socket); }, 1500);
                else startTurnTimer(match.id); // تشغيل المؤقت للخصم الحقيقي
            }
        } else {
            socket.emit('error_msg', 'حركة غير صالحة! القطعة لا تتطابق مع أطراف الرقعة.');
        }
    });

    // تمرير الدور أو السحب (Draw) إذا لم يمتلك اللاعب حجراً مناسباً
    socket.on('pass_domino_turn', (data) => {
        let match = activeDominoMatches[data.matchId];
        if (!match || match.turn !== socket.player.username) return;
        
        if (match.turnTimer) clearTimeout(match.turnTimer); // إيقاف المؤقت عند التمرير اليدوي

        let isPlayer1 = socket.player.username === match.player1;
        let myHand = isPlayer1 ? match.p1Hand : match.p2Hand;
        
        // --- قانون الإجبار على اللعب: التحقق مما إذا كان اللاعب يمتلك حجراً قابلاً للعب ---
        let hasValidMove = false;
        if (match.board.length === 0) {
            hasValidMove = true; // يجب عليه اللعب دائمًا إذا كانت الرقعة فارغة
        } else {
            hasValidMove = myHand.some(tile => tile[0] === match.leftEnd || tile[1] === match.leftEnd || tile[0] === match.rightEnd || tile[1] === match.rightEnd);
        }
        
        if (hasValidMove) {
            return socket.emit('error_msg', '❌ لا يمكنك السحب أو التمرير! لديك حجر مطابق في يدك يجب أن تلعبه.');
        }

        let p1Socket = io.sockets.sockets.get(match.player1SocketId);
        let p2Socket = match.isBotMatch ? null : io.sockets.sockets.get(match.player2SocketId);

        // إذا كانت السحبة متوفرة، اسحب قطع للاعب حتى يجد قطعة قابلة للعب
        if (match.boneyard && match.boneyard.length > 0) {
            let drawnTilesCount = 0;
            let foundPlayable = false;

            while (match.boneyard.length > 0) {
                let drawnTile = match.boneyard.pop();
                myHand.push(drawnTile);
                drawnTilesCount++;

                // التحقق مما إذا كانت القطعة الجديدة قابلة للعب
                if (match.board.length === 0 || drawnTile[0] === match.leftEnd || drawnTile[1] === match.leftEnd || drawnTile[0] === match.rightEnd || drawnTile[1] === match.rightEnd) {
                    foundPlayable = true;
                    break; // توقف عن السحب
                }
            }

            match.consecutivePasses = 0; // سحب ناجح
            
            if (p1Socket) p1Socket.emit('update_domino_board', { board: match.board, turn: match.turn, myHand: match.p1Hand, oppHandCount: match.p2Hand.length });
            if (p2Socket) p2Socket.emit('update_domino_board', { board: match.board, turn: match.turn, myHand: match.p2Hand, oppHandCount: match.p1Hand.length });
            
            if (foundPlayable) {
                socket.emit('error_msg', `تم سحب ${drawnTilesCount} قطعة لك حتى وجدت قطعة قابلة للعب. دورك الآن للعب.`);
                startTurnTimer(match.id); // إعادة بدء المؤقت لنفس اللاعب لأنه لا يزال دوره
                return;
            } else {
                // وصل إلى هنا إذا فرغت السحبة ولم يجد قطعة
                socket.emit('error_msg', `تم سحب جميع القطع المتبقية (${drawnTilesCount}) ولم تجد قطعة قابلة للعب. سيتم تمرير الدور.`);
                // الآن سيستمر الكود للأسفل لتمرير الدور
            }
        }

        // إذا نفذت السحبة، قم بتمرير الدور
        match.consecutivePasses++;
        if (match.consecutivePasses >= 2) {
            handleLockedGame(match);
            return;
        }

        match.turn = isPlayer1 ? match.player2 : match.player1;
        
        if (p1Socket) p1Socket.emit('update_domino_board', { board: match.board, turn: match.turn, myHand: match.p1Hand, oppHandCount: match.p2Hand.length });
        if (p2Socket) p2Socket.emit('update_domino_board', { board: match.board, turn: match.turn, myHand: match.p2Hand, oppHandCount: match.p1Hand.length });
        
        if (match.isBotMatch) setTimeout(() => { playBotTurn(match.id, socket); }, 1500);
        else startTurnTimer(match.id); // تشغيل المؤقت للخصم
    });
    
    // عند الانسحاب من الواجهة
    socket.on('surrender_domino_match', (matchId) => {
        let match = activeDominoMatches[matchId];
        if (match) {
            if (match.turnTimer) clearTimeout(match.turnTimer); // مسح المؤقت فور الانسحاب
            delete activeDominoMatches[matchId];
        }
    });

    // دالة محرك الروبوت (Bot AI)
    function playBotTurn(matchId, socket) {
        let match = activeDominoMatches[matchId];
        if (!match || !match.isBotMatch) return;

        let played = false;
        
        // دالة مساعدة لمحاولة وضع قطعة من يد الروبوت
        function tryToPlay() {
            if (match.board.length === 0) {
                let bestIdx = 0, highestDouble = -1, highestSum = -1;
                for (let i = 0; i < match.p2Hand.length; i++) {
                    let t = match.p2Hand[i];
                    if (t[0] === t[1] && t[0] > highestDouble) { highestDouble = t[0]; bestIdx = i; }
                    if (highestDouble === -1 && t[0]+t[1] > highestSum) { highestSum = t[0]+t[1]; bestIdx = i; }
                }
                let tile = match.p2Hand[bestIdx];
                match.board.push(tile); match.leftEnd = tile[0]; match.rightEnd = tile[1];
                match.p2Hand.splice(bestIdx, 1); played = true;
                return;
            }

            for (let i = 0; i < match.p2Hand.length; i++) {
                let tile = match.p2Hand[i];
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

        tryToPlay(); // المحاولة الأولى

        // السحب من الـ (Boneyard) إذا لم يجد قطعة مناسبة
        while (!played && match.boneyard && match.boneyard.length > 0) {
            let drawnTile = match.boneyard.pop(); // سحب قطعة جديدة من الباقي
            match.p2Hand.push(drawnTile); // إضافتها ليد الروبوت
            tryToPlay(); // المحاولة مرة أخرى بالقطعة الجديدة
        }

        if (played) {
            match.consecutivePasses = 0; // تصفير العداد لنجاح الروبوت باللعب
        } else {
            match.consecutivePasses++;
            if (match.consecutivePasses >= 2) {
                handleLockedGame(match);
                return;
            }
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
            startTurnTimer(matchId); // بدء المؤقت للاعب الحقيقي بعد أن أنهى الروبوت لعبته
        }
    }

    // دالة التعامل مع حالة انغلاق الرقعة (القفلة)
    function handleLockedGame(match) {
        if (match.turnTimer) clearTimeout(match.turnTimer); // مسح المؤقت نهائياً عند القفلة

        let p1Score = match.p1Hand.reduce((sum, tile) => sum + tile[0] + tile[1], 0);
        let p2Score = match.p2Hand.reduce((sum, tile) => sum + tile[0] + tile[1], 0);
        
        let p1Socket = io.sockets.sockets.get(match.player1SocketId);
        let p2Socket = match.isBotMatch ? null : io.sockets.sockets.get(match.player2SocketId);

        let winner, p1Msg, p2Msg;

        if (p1Score < p2Score) {
            winner = match.player1;
            if (p1Socket) p1Socket.player.balance += (match.entryPrice * 2);
            p1Msg = `🔒 قفلت الرقعة!\n🎉 مبروك! فزت لأن نقاطك (${p1Score}) أقل من الخصم (${p2Score}).`;
            p2Msg = `🔒 قفلت الرقعة!\n😢 خسرت لأن نقاطك (${p2Score}) أعلى من الخصم (${p1Score}).`;
        } else if (p2Score < p1Score) {
            winner = match.player2;
            if (p2Socket) p2Socket.player.balance += (match.entryPrice * 2);
            p1Msg = `🔒 قفلت الرقعة!\n😢 خسرت لأن نقاطك (${p1Score}) أعلى من الخصم (${p2Score}).`;
            p2Msg = `🔒 قفلت الرقعة!\n🎉 مبروك! فزت لأن نقاطك (${p2Score}) أقل من الخصم (${p1Score}).`;
        } else {
            winner = "تعادل";
            if (p1Socket) p1Socket.player.balance += match.entryPrice;
            if (p2Socket) p2Socket.player.balance += match.entryPrice;
            p1Msg = `🔒 قفلت الرقعة!\n🤝 تعادل! لكلاكما نفس النقاط (${p1Score}). تم استرجاع رسوم الدخول.`;
            p2Msg = `🔒 قفلت الرقعة!\n🤝 تعادل! لكلاكما نفس النقاط (${p2Score}). تم استرجاع رسوم الدخول.`;
        }

        if (p1Socket) {
            p1Socket.emit('update_domino_board', { board: match.board, turn: '', myHand: match.p1Hand, oppHandCount: match.p2Hand.length });
            p1Socket.emit('domino_match_ended', { winner: winner, msg: p1Msg, newBalance: p1Socket.player.balance });
        }
        if (p2Socket) {
            p2Socket.emit('update_domino_board', { board: match.board, turn: '', myHand: match.p2Hand, oppHandCount: match.p1Hand.length });
            p2Socket.emit('domino_match_ended', { winner: winner, msg: p2Msg, newBalance: p2Socket.player.balance });
        }

        delete activeDominoMatches[match.id];
        saveDatabase();
    }

    // --- دالة بدء مؤقت الدور لمعاقبة اللاعب البطيء ---
    function startTurnTimer(matchId) {
        let match = activeDominoMatches[matchId];
        if (!match) return;
        
        if (match.turnTimer) clearTimeout(match.turnTimer); // مسح أي مؤقت سابق ضماناً لعدم التداخل

        match.turnTimer = setTimeout(() => {
            let currentPlayerName = match.turn;
            let isPlayer1 = currentPlayerName === match.player1;
            let myHand = isPlayer1 ? match.p1Hand : match.p2Hand;
            
            let p1Socket = io.sockets.sockets.get(match.player1SocketId);
            let p2Socket = match.isBotMatch ? null : io.sockets.sockets.get(match.player2SocketId);
            let currentSocket = isPlayer1 ? p1Socket : p2Socket;

            // التحقق مما إذا كان اللاعب يمتلك حركة صالحة
            let hasValidMove = false;
            if (match.board.length === 0) {
                hasValidMove = true;
            } else {
                hasValidMove = myHand.some(tile => tile[0] === match.leftEnd || tile[1] === match.leftEnd || tile[0] === match.rightEnd || tile[1] === match.rightEnd);
            }

            // 1. محاولة السحب التلقائي إذا انتهى الوقت وكانت السحبة متوفرة (بشرط ألا يمتلك حركة صالحة)
            if (match.boneyard && match.boneyard.length > 0 && !hasValidMove) {
                let drawnTile = match.boneyard.pop();
                myHand.push(drawnTile);
                match.consecutivePasses = 0;
                
                if (p1Socket) p1Socket.emit('update_domino_board', { board: match.board, turn: match.turn, myHand: match.p1Hand, oppHandCount: match.p2Hand.length });
                if (p2Socket) p2Socket.emit('update_domino_board', { board: match.board, turn: match.turn, myHand: match.p2Hand, oppHandCount: match.p1Hand.length });
                if (currentSocket) currentSocket.emit('error_msg', '⏳ انتهى وقتك! تم سحب قطعة لك تلقائياً.');
                startTurnTimer(matchId); // إعادة تشغيل المؤقت لإعطائه فرصة للعب بالقطعة الجديدة
                return;
            }

            // 2. تمرير الدور إجبارياً إذا لم تكن هناك سحبة
            match.consecutivePasses++;
            if (match.consecutivePasses >= 2) {
                handleLockedGame(match);
                return;
            }

            match.turn = isPlayer1 ? match.player2 : match.player1;
            if (currentSocket) currentSocket.emit('error_msg', '⏳ انتهى وقتك! تم تمرير الدور لخصمك.');
            
            if (p1Socket) p1Socket.emit('update_domino_board', { board: match.board, turn: match.turn, myHand: match.p1Hand, oppHandCount: match.p2Hand.length });
            if (p2Socket) p2Socket.emit('update_domino_board', { board: match.board, turn: match.turn, myHand: match.p2Hand, oppHandCount: match.p1Hand.length });
            
            if (match.isBotMatch) {
                if (p1Socket) setTimeout(() => { playBotTurn(match.id, p1Socket); }, 1500);
            } else {
                startTurnTimer(matchId);
            }
        }, 15000); // 15 ثانية (يمكنك تقليلها أو زيادتها من هنا)
    }
});

server.listen(3000, () => {
    console.log('الخادم الآمن يعمل على الرابط: http://localhost:3000');
});