// हिंदी — everyday spoken Hindi, not formal or literary.
//
// The register is deliberate: this is what a shopkeeper says out loud, so
// English words that people actually use in Hindi ("Excel", "फॉर्म") are kept
// rather than replaced with pure-Hindi equivalents nobody says.
//
// Keys must match ./en.js exactly — tests/i18n.test.js enforces it.

export default {
  "language.changed": "✅ भाषा हिंदी कर दी गई है।",

  "language.button": "🌐 भाषा: {label}",

  "setup.greeting": "नमस्ते {name}!",
  "setup.greetingAnon": "नमस्ते!",

  "setup.welcome": `👋 {greeting} मैं आपका हिसाब-किताब रखने वाला हूँ।

बस लिखिए क्या हुआ — जैसे "600 का 10 किलो चावल लिया" — और मैं आपकी बही
में लिख दूँगा। न कोई फॉर्म, न Excel।

पहले ये बताइए, किसका हिसाब रखना है?

दूसरा बाद में भी जोड़ सकते हैं, अभी पक्का नहीं करना है।`,

  "setup.shopButton": "🏪 मेरी दुकान — बिक्री, खरीद, उधार",
  "setup.homeButton": "🏠 मेरा घर — घर का खर्च",

  "workspace.nameShop": "मेरी दुकान",
  "workspace.nameHome": "मेरा घर",

  "workspace.switched": "{workspace} पर आ गए",
  "workspace.nowUsing": "✅ अभी {workspace} चल रहा है",
  "workspace.ready": "{workspace} तैयार है।",

  "practice.prompt": `एक बार करके देखते हैं — 30 सेकंड लगेंगे।

ये लिखिए, या अपने हिसाब से कुछ भी:

{example}`,

  "practice.skip": "⏭ अभी नहीं",

  // Deliberately does not name the Confirm button: it is called "सही है"
  // here, not "Confirm", and copy that names a button has to be rewritten
  // every time the button is.
  "tour.intro": `🎉 बस इतना ही है — पूरा ऐप यही है।

और क्या-क्या कर सकता हूँ, देखना है?`,

  "tour.more": "और कुछ?",

  "tour.summary": "📊 आज का हिसाब",
  "tour.monthly": "📅 इस महीने का",
  "tour.transactions": "📋 आज की एंट्री",
  "tour.udhaar": "📒 किसका उधार बाकी है",

  "tour.finish": "✅ हो गया",

  "clear.prompt": `बस एक आखिरी बात।

सीखते समय की एंट्री आपकी बही में: {count}

इन्हें हटा दें ताकि असली हिसाब शून्य से शुरू हो?`,

  "clear.button": "🧹 हटा दीजिए",
  "keep.button": "📌 रहने दीजिए",

  "finish.done": "✅ सब हो गया।",
  "finish.cleared": "✅ सब हो गया। हटाई गई एंट्री: {count}",
  "finish.kept": "✅ सब हो गया। आपकी एंट्री बही में रहेंगी।",

  "toast.setupAlreadyDone": "ये पहले ही हो चुका है।",
  "toast.cleared": "एंट्री हटा दी गईं।",
  "toast.setupComplete": "सब तैयार है।",

  "confirm.title": "📝 लिखूँ?",

  // "कितना" would read as a second amount right above "रकम", so the quantity
  // row asks "how many" instead — and it only appears when it is more than 1.
  "confirm.quantity": "नग:",
  "confirm.amount": "रकम:",
  "confirm.date": "तारीख:",
  "confirm.description": "क्या:",
  "confirm.from": "किससे:",

  "confirm.khataChange": "{person} का बाकी: {before} → {after}",

  "confirm.yes": "✅ हाँ",
  "confirm.no": "❌ नहीं",

  "confirm.savedTitle": "✅ बही में लिख दिया",

  "confirm.titleMulti": "📝 ये {count} लिखूँ?",
  "confirm.savedTitleMulti": "✅ बही में लिख दिया ({count})",
  "confirm.total": "कुल:",
  "toast.savedMulti": "{count} एंट्री लिख दीं!",

  "skipped.noAmount":
    "⚠️ {count} छोड़ दीं — कितने रुपये थे दिखा नहीं। वो दोबारा रकम के साथ लिखिए।",
  "skipped.invalid": "⚠️ {count} छोड़ दीं, वो समझ नहीं आईं।",
  "skipped.capped":
    "⚠️ एक बार में {max} तक ही लिख सकता हूँ — बाकी {count} अलग से लिखिए।",

  "error.noAmount":
    "कितने रुपये? रकम के साथ दोबारा लिखिए, जैसे \"500 का सामान लिया\"।",
  "confirm.cancelled": "❌ रहने दिया, कुछ नहीं लिखा।",

  "toast.saved": "बही में लिख दिया!",
  "toast.cancelled": "रहने दिया।",

  "khata.nowOwes": "📒 {person} का अब {amount} बाकी है",
  "khata.advance": "📒 {person} ने {amount} पहले ही दे दिए हैं",

  "clarify.owes": "{person} का अभी बाकी है: {amount}",
  "clarify.noUdhaar": "{person} का कोई उधार अभी लिखा नहीं है।",
  "clarify.question":
    "❓ {person} ने ये पैसे उधार चुकाने के लिए दिए, या ये आम पेमेंट है?",
  "clarify.repayment": "📒 उधार चुकाया",
  "clarify.normal": "💰 आम पेमेंट",

  // Each type label is followed by a colon and a thing on the confirmation
  // card — "खरीद: 10 किलो चावल" — so each has to read as a noun, not a verb.
  "type.sale": "बिक्री",
  "type.purchase": "खरीद",
  "type.expense": "खर्च",
  "type.income": "आमदनी",
  "type.payment_received": "पैसे आए",
  "type.payment_sent": "पैसे गए",
  "type.credit_sale": "उधार",
  "type.repayment": "उधार चुकाया",
  "type.other": "दूसरा",

  "cat.groceries": "किराना",
  "cat.food": "खाना",
  "cat.electricity": "बिजली",
  "cat.water": "पानी",
  "cat.gas": "गैस",
  "cat.rent": "किराया",
  "cat.transport": "आना-जाना",
  "cat.education": "पढ़ाई",
  "cat.medical": "दवा-इलाज",
  "cat.shopping": "खरीदारी",
  "cat.entertainment": "मनोरंजन",
  "cat.subscriptions": "हर महीने का",
  "cat.salary": "तनख्वाह",
  "cat.stock": "माल",
  "cat.other": "दूसरा",

  "summary.dailyTitle": "📊 {workspace} — आज",
  "summary.monthlyTitle": "📊 {workspace} — इस महीने",
  "summary.date": "तारीख:",
  "summary.count": "एंट्री:",

  "summary.whereItWent": "कहाँ खर्च हुआ:",

  "list.title": "📋 {workspace} — आज की एंट्री",
  "list.empty": "📋 {date} को {workspace} में कुछ नहीं लिखा।",
  "list.customer": "ग्राहक:",

  "udhaar.title": "📒 उधार बही",
  "udhaar.total": "कुल बाकी:",
  "udhaar.empty": `📒 अभी किसी का कुछ बाकी नहीं है।

जब आप लिखेंगे "राज ने 2000 का माल उधार लिया", तब से राज यहाँ दिखेगा, जब तक वो चुका न दे।`,

  "khata.noCustomer": '🔍 आपकी बही में "{person}" नाम का कोई ग्राहक नहीं है।',
  "khata.cleared": "✅ {person} ने सब चुका दिया। कुछ बाकी नहीं।",
  "khata.paidAdvance": "💰 {person} ने {amount} पहले ही दे दिए हैं। कुछ बाकी नहीं।",
  "khata.owesYou": "📒 {person} का {amount} बाकी है।",
  "khata.title": "📋 खाता — {person}",
  "khata.noEntries": "📋 {person} की अभी कोई एंट्री नहीं है।",
  "khata.outstanding": "बाकी:",

  "ws.current": "कौन सी बही?",
  "toast.notFound": "वो एंट्री नहीं मिली।",
  "toast.alreadyDone": "ये पहले ही हो चुका है।",
  "toast.dataMissing": "उस एंट्री की जानकारी नहीं मिली।",
  "toast.chooseFirst": "पहले बताइए ये पैसे किस लिए थे।",
  "toast.unknownAction": "ये बटन समझ नहीं आया।",
  "toast.wentWrong": "कुछ गड़बड़ हो गई।",
  "toast.unknownWorkspace": "ये बही समझ नहीं आई।",
  "toast.workspaceNotFound": "बही नहीं मिली।",
  "toast.unknownLanguage": "ये भाषा नहीं है।",

  "error.summary": "माफ कीजिए, आज का हिसाब नहीं बना पाया।",
  "error.monthly": "माफ कीजिए, इस महीने का हिसाब नहीं बना पाया।",
  "error.transactions": "माफ कीजिए, आज की एंट्री नहीं ला पाया।",
  "error.udhaar": "माफ कीजिए, उधार बही नहीं खोल पाया।",
  "error.workspaces": "माफ कीजिए, आपकी बहियाँ नहीं ला पाया।",
  "error.language": "माफ कीजिए, भाषा की सेटिंग नहीं खोल पाया।",
  "error.transaction": "माफ कीजिए, ये समझ नहीं आया।",

  "error.rateLimit":
    "एक साथ बहुत हो गया — एक मिनट रुकिए, फिर लिखते रहिए।",

  // --------------------------------------------------
  // मेन्यू
  // --------------------------------------------------

  "help.menu":
    "📒 आप {workspace} में हैं\n\nजो हुआ वो बता दीजिए, मैं लिख लूँगा।\n\"1200 की 3 शर्ट बेचीं\"\n\"राजू ने 500 का सामान उधार लिया\"\n\nकमांड: /menu /summary /monthly /transactions /udhaar /workspace /language",

  "menu.thisLedger": "📊 इस महीने — {workspace}",
  "menu.allLedgers": "🌍 इस महीने — सभी बहीखाते",
  "menu.switch": "🔀 बहीखाता बदलें",
  "menu.newLedger": "➕ नया बहीखाता",
  "menu.allTitle": "🌍 सभी बहीखाते",
  "menu.everything": "कुल:",
  "menu.allEmpty": "इस महीने अभी किसी भी बहीखाते में कुछ नहीं लिखा गया।",

  // --------------------------------------------------
  // नया बहीखाता
  // --------------------------------------------------

  "ledger.prompt":
    "➕ नया बहीखाता\n\nएक इमोजी और नाम साथ में भेजिए:\n\n🏍️ बाइक\n🌾 खेत\n🏪 दूसरी दुकान\n\nसिर्फ नाम भी चलेगा — तब मैं 📒 लगा दूँगा।",
  "ledger.created": "✅ {workspace} तैयार है, और अब आप उसी में हैं।",
  "ledger.needName": "ये सिर्फ इमोजी है — साथ में नाम भी भेजिए, जैसे 🏍️ बाइक।",
  "ledger.duplicate":
    "{ledger} पहले से है। दूसरा नाम रखिए, या /menu से उसी में चले जाइए।",
  "ledger.tooMany":
    "आपके पास {max} बहीखाते हैं, इससे ज़्यादा मैं सँभाल नहीं पाऊँगा। किसी पुराने का ही इस्तेमाल कीजिए।",

  // --------------------------------------------------
  // पैसा किधर गया
  // --------------------------------------------------

  "card.moneyIn": "पैसे आए",
  "card.moneyOut": "पैसे गए",

  "summary.moneyIn": "आए:",
  "summary.moneyOut": "गए:",
  "summary.net": "बचे:",
  "summary.onUdhaar": "उधार पर:",

  "khata.youOwe": "📒 आपको {person} को {amount} देने हैं।",

  // --------------------------------------------------
  // शुरुआत
  // --------------------------------------------------

  "setup.ownButton": "✏️ अपना बनाऊँ",
  "ws.hint": "अब आप जो भी लिखेंगे वो इसी बहीखाते में जाएगा।",
  "practice.example": "600 के 10 किलो चावल खरीदे",
};
