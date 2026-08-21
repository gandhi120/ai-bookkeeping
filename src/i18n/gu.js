// ગુજરાતી — everyday spoken Gujarati, not formal or literary.
//
// Same register rule as ./hi.js: this is how a shopkeeper in Gujarat actually
// talks, so common English words ("Excel", "Confirm") stay as they are said
// rather than being translated into words nobody uses.
//
// "ઉધાર" (udhaar) is the word for goods taken on credit and is used
// throughout, because it is what the khata is called in the shop.
//
// Keys must match ./en.js exactly — tests/i18n.test.js enforces it.

export default {
  "language.changed": "✅ ભાષા ગુજરાતી કરી દીધી છે.",

  "language.button": "🌐 ભાષા: {label}",

  "setup.greeting": "નમસ્તે {name}!",
  "setup.greetingAnon": "નમસ્તે!",

  "setup.welcome": `👋 {greeting} હું તમારો હિસાબ રાખનારો છું.

બસ લખો શું થયું — જેમ કે "600 ના 10 કિલો ચોખા લીધા" — અને હું તમારા
ચોપડામાં લખી દઈશ. કોઈ ફોર્મ નહીં, Excel નહીં.

પહેલા એ કહો, કોનો હિસાબ રાખવાનો છે?

બીજું પછી પણ ઉમેરી શકાય છે, અત્યારે નક્કી કરવાની જરૂર નથી.`,

  "setup.shopButton": "🏪 મારી દુકાન — વેચાણ, ખરીદી, ઉધાર",
  "setup.homeButton": "🏠 મારું ઘર — ઘરનો ખર્ચ",

  "workspace.nameShop": "મારી દુકાન",
  "workspace.nameHome": "મારું ઘર",

  "workspace.switched": "{workspace} પર આવી ગયા",
  "workspace.nowUsing": "✅ અત્યારે {workspace} ચાલુ છે",
  "workspace.ready": "{workspace} તૈયાર છે.",

  "practice.prompt": `એક વાર કરી જોઈએ — 30 સેકન્ડ થશે.

આ લખો, અથવા તમારી રીતે કંઈ પણ:

{example}`,

  "practice.skip": "⏭ અત્યારે નહીં",

  // Deliberately does not name the Confirm button: it is called "બરાબર છે"
  // here, not "Confirm", and copy that names a button has to be rewritten
  // every time the button is.
  "tour.intro": `🎉 બસ આટલું જ — આખી ઍપ આટલી જ છે.

બીજું શું શું કરી શકું છું, જોવું છે?`,

  "tour.more": "બીજું કંઈ?",

  "tour.summary": "📊 આજનો હિસાબ",
  "tour.monthly": "📅 આ મહિનાનો",
  "tour.transactions": "📋 આજની એન્ટ્રી",
  "tour.udhaar": "📒 કોનું ઉધાર બાકી છે",

  "tour.finish": "✅ થઈ ગયું",

  "clear.prompt": `બસ છેલ્લી એક વાત.

શીખતી વખતની એન્ટ્રી તમારા ચોપડામાં: {count}

એ કાઢી નાખું જેથી સાચો હિસાબ શૂન્યથી શરૂ થાય?`,

  "clear.button": "🧹 કાઢી નાખો",
  "keep.button": "📌 રહેવા દો",

  "finish.done": "✅ બધું થઈ ગયું.",
  "finish.cleared": "✅ બધું થઈ ગયું. કાઢેલી એન્ટ્રી: {count}",
  "finish.kept": "✅ બધું થઈ ગયું. તમારી એન્ટ્રી ચોપડામાં રહેશે.",

  "toast.setupAlreadyDone": "આ પહેલેથી થઈ ગયું છે.",
  "toast.cleared": "એન્ટ્રી કાઢી નાખી.",
  "toast.setupComplete": "બધું તૈયાર છે.",

  "confirm.title": "📝 લખું?",

  // The old "કેટલું:" sat directly above "રકમ:" and read as a second amount.
  // "નંગ" is how a quantity is actually said in a shop, and the row only
  // appears when it is more than 1.
  "confirm.quantity": "નંગ:",
  "confirm.amount": "રકમ:",
  "confirm.date": "તારીખ:",
  "confirm.description": "શું:",
  "confirm.from": "કોની પાસેથી:",

  // નું attaches straight to the name with no space — "રાજનું બાકી".
  "confirm.khataChange": "{person}નું બાકી: {before} → {after}",

  "confirm.yes": "✅ હા",
  "confirm.no": "❌ ના",

  "confirm.savedTitle": "✅ ચોપડામાં લખી દીધું",

  "confirm.titleMulti": "📝 આ {count} લખું?",
  "confirm.savedTitleMulti": "✅ ચોપડામાં લખી દીધું ({count})",
  "confirm.total": "કુલ:",
  "toast.savedMulti": "{count} એન્ટ્રી લખી દીધી!",

  "skipped.noAmount":
    "⚠️ {count} છોડી દીધી — કેટલા રૂપિયા એ દેખાયું નહીં. એ ફરીથી રકમ સાથે લખો.",
  "skipped.invalid": "⚠️ {count} છોડી દીધી, એ સમજાઈ નહીં.",
  "skipped.capped":
    "⚠️ એક વારમાં {max} સુધી જ લખી શકું — બાકીની {count} અલગથી લખો.",

  "error.noAmount":
    "કેટલા રૂપિયા? રકમ સાથે ફરીથી લખો, જેમ કે \"500 નું કરિયાણું લીધું\".",
  "confirm.cancelled": "❌ રહેવા દીધું, કંઈ લખ્યું નથી.",

  "toast.saved": "ચોપડામાં લખી દીધું!",
  "toast.cancelled": "રહેવા દીધું.",

  "khata.nowOwes": "📒 {person}નું હવે {amount} બાકી છે",
  "khata.advance": "📒 {person}એ {amount} અગાઉથી આપી દીધા છે",

  "clarify.owes": "{person}નું અત્યારે બાકી: {amount}",
  "clarify.noUdhaar": "{person}નું કોઈ ઉધાર હજી લખ્યું નથી.",
  "clarify.question":
    "❓ {person}એ આ પૈસા ઉધાર ચૂકવવા આપ્યા, કે આ સામાન્ય પેમેન્ટ છે?",
  "clarify.repayment": "📒 ઉધાર ચૂકવ્યું",
  "clarify.normal": "💰 સામાન્ય પેમેન્ટ",

  // Each label is followed by a colon and a thing on the confirmation card —
  // "ખરીદી: 10 કિલો ચોખા" — so each has to read as a noun, not a verb.
  "type.sale": "વેચાણ",
  "type.purchase": "ખરીદી",
  "type.expense": "ખર્ચ",
  "type.income": "આવક",
  "type.payment_received": "પૈસા આવ્યા",
  "type.payment_sent": "પૈસા ગયા",
  "type.credit_sale": "ઉધાર",
  "type.repayment": "ઉધાર ચૂકવ્યું",
  "type.other": "બીજું",

  "cat.groceries": "કરિયાણું",
  "cat.food": "ખાવાનું",
  "cat.electricity": "લાઈટબિલ",
  "cat.water": "પાણી",
  "cat.gas": "ગૅસ",
  "cat.rent": "ભાડું",
  "cat.transport": "આવવા-જવાનું",
  "cat.education": "ભણતર",
  "cat.medical": "દવા-દારૂ",
  "cat.shopping": "ખરીદી",
  "cat.entertainment": "મોજશોખ",
  "cat.subscriptions": "દર મહિનાનું",
  "cat.salary": "પગાર",
  "cat.stock": "માલ",
  "cat.other": "બીજું",

  "summary.dailyTitle": "📊 {workspace} — આજે",
  "summary.monthlyTitle": "📊 {workspace} — આ મહિને",
  "summary.date": "તારીખ:",
  "summary.count": "એન્ટ્રી:",

  "summary.whereItWent": "ક્યાં ખર્ચ થયું:",

  "list.title": "📋 {workspace} — આજની એન્ટ્રી",
  "list.empty": "📋 {date} ના રોજ {workspace} માં કંઈ લખ્યું નથી.",
  "list.customer": "ગ્રાહક:",

  "udhaar.title": "📒 ઉધાર ચોપડો",
  "udhaar.total": "કુલ બાકી:",
  "udhaar.empty": `📒 અત્યારે કોઈનું કંઈ બાકી નથી.

તમે લખશો "રાજે 2000 નો માલ ઉધાર લીધો", ત્યારથી રાજ અહીં દેખાશે, જ્યાં સુધી એ ચૂકવે નહીં.`,

  "khata.noCustomer": '🔍 તમારા ચોપડામાં "{person}" નામનો કોઈ ગ્રાહક નથી.',
  "khata.cleared": "✅ {person}એ બધું ચૂકવી દીધું. કંઈ બાકી નથી.",
  "khata.paidAdvance": "💰 {person}એ {amount} અગાઉથી આપી દીધા છે. કંઈ બાકી નથી.",
  "khata.owesYou": "📒 {person}નું {amount} બાકી છે.",
  "khata.title": "📋 ખાતું — {person}",
  "khata.noEntries": "📋 {person}ની હજી કોઈ એન્ટ્રી નથી.",
  "khata.outstanding": "બાકી:",

  "ws.current": "કયો ચોપડો?",
  "toast.notFound": "એ એન્ટ્રી મળી નહીં.",
  "toast.alreadyDone": "આ પહેલેથી થઈ ગયું છે.",
  "toast.dataMissing": "એ એન્ટ્રીની વિગત મળી નહીં.",
  "toast.chooseFirst": "પહેલા કહો આ પૈસા શેના માટે હતા.",
  "toast.unknownAction": "આ બટન સમજાયું નહીં.",
  "toast.wentWrong": "કંઈક ગડબડ થઈ.",
  "toast.unknownWorkspace": "આ ચોપડો સમજાયો નહીં.",
  "toast.workspaceNotFound": "ચોપડો મળ્યો નહીં.",
  "toast.unknownLanguage": "આ ભાષા નથી.",

  "error.summary": "માફ કરજો, આજનો હિસાબ બનાવી શક્યો નહીં.",
  "error.monthly": "માફ કરજો, આ મહિનાનો હિસાબ બનાવી શક્યો નહીં.",
  "error.transactions": "માફ કરજો, આજની એન્ટ્રી લાવી શક્યો નહીં.",
  "error.udhaar": "માફ કરજો, ઉધાર ચોપડો ખોલી શક્યો નહીં.",
  "error.workspaces": "માફ કરજો, તમારા ચોપડા લાવી શક્યો નહીં.",
  "error.language": "માફ કરજો, ભાષાનું સેટિંગ ખોલી શક્યો નહીં.",
  "error.transaction": "માફ કરજો, આ સમજાયું નહીં.",

  "error.rateLimit":
    "એકસાથે બહુ થઈ ગયું — એક મિનિટ થોભો, પછી લખતા રહો.",

  // --------------------------------------------------
  // મેનુ
  // --------------------------------------------------

  "help.menu":
    "📒 તમે {workspace} માં છો\n\nજે થયું એ કહી દો, હું લખી લઈશ.\n\"1200 ના 3 શર્ટ વેચ્યા\"\n\"રાજુએ 500 નો સામાન ઉધાર લીધો\"\n\nકમાન્ડ: /menu /summary /monthly /transactions /udhaar /workspace /language",

  "menu.thisLedger": "📊 આ મહિનો — {workspace}",
  "menu.allLedgers": "🌍 આ મહિનો — બધા ચોપડા",
  "menu.switch": "🔀 ચોપડો બદલો",
  "menu.newLedger": "➕ નવો ચોપડો",
  "menu.allTitle": "🌍 બધા ચોપડા",
  "menu.everything": "કુલ:",
  "menu.allEmpty": "આ મહિને હજી કોઈ ચોપડામાં કંઈ લખાયું નથી.",

  // --------------------------------------------------
  // નવો ચોપડો
  // --------------------------------------------------

  "ledger.prompt":
    "➕ નવો ચોપડો\n\nઈમોજી અને નામ સાથે મોકલો:\n\n🏍️ બાઇક\n🌾 ખેતર\n🏪 બીજી દુકાન\n\nફક્ત નામ પણ ચાલશે — તો હું 📒 મૂકી દઈશ.",
  "ledger.created": "✅ {workspace} તૈયાર છે, અને હવે તમે એમાં જ છો.",
  "ledger.needName": "આ તો ફક્ત ઈમોજી છે — સાથે નામ પણ મોકલો, જેમ કે 🏍️ બાઇક.",
  "ledger.duplicate":
    "{ledger} પહેલેથી છે. બીજું નામ રાખો, અથવા /menu માંથી એમાં જ જાઓ.",
  "ledger.tooMany":
    "તમારી પાસે {max} ચોપડા છે, એથી વધારે હું સંભાળી નહીં શકું. જૂનામાંથી જ કોઈ વાપરો.",

  // --------------------------------------------------
  // પૈસા કઈ બાજુ
  // --------------------------------------------------

  "card.moneyIn": "પૈસા આવ્યા",
  "card.moneyOut": "પૈસા ગયા",

  "summary.moneyIn": "આવ્યા:",
  "summary.moneyOut": "ગયા:",
  "summary.net": "બચ્યા:",
  "summary.onUdhaar": "ઉધાર પર:",

  "khata.youOwe": "📒 તમારે {person} ને {amount} આપવાના છે.",

  // --------------------------------------------------
  // શરૂઆત
  // --------------------------------------------------

  "setup.ownButton": "✏️ મારું પોતાનું",
  "ws.hint": "હવે તમે જે લખશો એ આ ચોપડામાં જ જશે.",
  "practice.example": "600 ના 10 કિલો ચોખા ખરીદ્યા",
};
