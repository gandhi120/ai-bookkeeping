// The gym module's OWN strings, in the three languages the bot speaks.
//
// Deliberately NOT added to src/i18n/en.js and its two siblings. Those are the
// bookkeeping catalogs, guarded by tests/i18n.test.js which asserts all three
// have identical keys — so adding gym keys there would make a gym typo fail
// the bookkeeping test suite. Keeping them here means this module can be
// deleted by deleting its folder.
//
// Same fallback rule as the main catalog: unknown language, then unknown key,
// both fall through to English. That is what lets a translation lag by a
// screen without anything breaking.

const CATALOGS = {
  en: {
    "gym.saving": "Saving…",
    "gym.pickDay": "🏋️ Which day?",
    "gym.blank": "—",
    "gym.thisWeek": "This week",
    "gym.weekTag": "(week)",
    "gym.forTheWeek": "for the whole week",
    "gym.back": "← Back",
    "gym.backToDays": "← Another day",
    "gym.outOfRange": "That is out of range for {field}. Try again?",
    "gym.notANumber": "I need a number for {field}. Try again?",
    "gym.hint.bodyweight": "Reply with the number, like 82.5",
    "gym.hint.sleep": "Reply with the hours, like 7 or 7h30",
    "gym.hint.steps": "Reply with the count, like 8200 or 8.2k",
    "gym.hint.offPlan": "Reply with what you ate off plan",
    "gym.hint.discomfort": "Reply with what hurt or felt off",
    "gym.ph.bodyweight": "82.5",
    "gym.ph.sleep": "7h30",
    "gym.ph.steps": "8200",
    "gym.ph.offPlan": "2 samosas",
    "gym.ph.discomfort": "knee pain",
    "gym.saved": "🏋️ Saved to your sheet",
    "gym.date": "Date:",
    "gym.bodyweight": "Bodyweight",
    "gym.nutrition": "Nutrition",
    "gym.hydration": "Hydration",
    "gym.exercise": "Exercise",
    "gym.sleep": "Sleep",
    "gym.steps": "Steps",
    "gym.offPlan": "Off plan",
    "gym.discomfort": "Discomfort",
    "gym.resend": "Wrong? Send it again — same day overwrites the same row.",
    "gym.ask":
      "🏋️ Send your check-in in one message, like:\n\n82.5kg, nutrition 4, water 3, exercise 5, slept 7h, 8200 steps\n\nAnything you leave out stays blank.",
    "gym.nothing":
      "I could not find a check-in in that. Try: 82.5kg, nutrition 4, slept 7h",
    "gym.badValue":
      "One of those looked wrong — nutrition, water and exercise are scores out of 5. Send it again?",
    "gym.notConfigured":
      "The gym sheet is not connected yet. GYM_SHEET_URL and GYM_SHEET_SECRET need to be set.",
    "gym.readFailed": "I could not open your sheet just now. Nothing was changed — try again in a minute.",
    "gym.sheetFailed":
      "I read your check-in but could not write it to the sheet. Nothing was saved — try again in a minute.",
    "gym.noRow":
      "Your sheet has no row for {date}. The tracker may have run past its last week.",
    "gym.error": "Something went wrong reading that. Try again?",
  },

  hi: {
    "gym.saving": "लिख रहा हूँ…",
    "gym.pickDay": "🏋️ कौन सा दिन?",
    "gym.blank": "—",
    "gym.thisWeek": "इस हफ़्ते",
    "gym.weekTag": "(हफ़्ता)",
    "gym.forTheWeek": "पूरे हफ़्ते के लिए",
    "gym.back": "← वापस",
    "gym.backToDays": "← दूसरा दिन",
    "gym.outOfRange": "{field} के लिए यह आँकड़ा सही नहीं है। दोबारा भेजें?",
    "gym.notANumber": "{field} के लिए मुझे नंबर चाहिए। दोबारा भेजें?",
    "gym.hint.bodyweight": "नंबर भेजिए, जैसे 82.5",
    "gym.hint.sleep": "घंटे भेजिए, जैसे 7 या 7h30",
    "gym.hint.steps": "गिनती भेजिए, जैसे 8200 या 8.2k",
    "gym.hint.offPlan": "प्लान से बाहर क्या खाया, वो लिखिए",
    "gym.hint.discomfort": "कहाँ दर्द या तकलीफ़ हुई, वो लिखिए",
    "gym.ph.bodyweight": "82.5",
    "gym.ph.sleep": "7h30",
    "gym.ph.steps": "8200",
    "gym.ph.offPlan": "2 समोसे",
    "gym.ph.discomfort": "घुटने में दर्द",
    "gym.saved": "🏋️ आपकी शीट में लिख दिया",
    "gym.date": "तारीख:",
    "gym.bodyweight": "वज़न",
    "gym.nutrition": "खानपान",
    "gym.hydration": "पानी",
    "gym.exercise": "कसरत",
    "gym.sleep": "नींद",
    "gym.steps": "कदम",
    "gym.offPlan": "प्लान से बाहर",
    "gym.discomfort": "तकलीफ़",
    "gym.resend": "ग़लत है? दोबारा भेज दीजिए — उसी दिन की वही लाइन बदल जाएगी।",
    "gym.ask":
      "🏋️ अपना चेक-इन एक ही मैसेज में भेजिए, जैसे:\n\n82.5kg, nutrition 4, पानी 3, कसरत 5, 7 घंटे सोया, 8200 कदम\n\nजो नहीं लिखेंगे वो खाली रहेगा।",
    "gym.nothing":
      "इसमें मुझे चेक-इन नहीं मिला। ऐसे लिखिए: 82.5kg, nutrition 4, 7 घंटे सोया",
    "gym.badValue":
      "कोई एक आँकड़ा ठीक नहीं लगा — खानपान, पानी और कसरत 5 में से होते हैं। दोबारा भेजें?",
    "gym.notConfigured":
      "जिम शीट अभी जुड़ी नहीं है। GYM_SHEET_URL और GYM_SHEET_SECRET सेट करने होंगे।",
    "gym.readFailed": "अभी आपकी शीट खुल नहीं पाई। कुछ भी बदला नहीं — एक मिनट बाद दोबारा भेजिए।",
    "gym.sheetFailed":
      "चेक-इन पढ़ लिया, पर शीट में लिख नहीं पाया। कुछ भी सेव नहीं हुआ — एक मिनट बाद दोबारा भेजिए।",
    "gym.noRow":
      "आपकी शीट में {date} की कोई लाइन नहीं है। शायद ट्रैकर का आख़िरी हफ़्ता निकल गया है।",
    "gym.error": "कुछ गड़बड़ हो गई। दोबारा भेजिए?",
  },

  gu: {
    "gym.saving": "લખું છું…",
    "gym.pickDay": "🏋️ કયો દિવસ?",
    "gym.blank": "—",
    "gym.thisWeek": "આ અઠવાડિયે",
    "gym.weekTag": "(અઠવાડિયું)",
    "gym.forTheWeek": "આખા અઠવાડિયા માટે",
    "gym.back": "← પાછા",
    "gym.backToDays": "← બીજો દિવસ",
    "gym.outOfRange": "{field} માટે આ આંકડો બરાબર નથી. ફરી મોકલો?",
    "gym.notANumber": "{field} માટે મને નંબર જોઈએ. ફરી મોકલો?",
    "gym.hint.bodyweight": "નંબર મોકલો, જેમ કે 82.5",
    "gym.hint.sleep": "કલાક મોકલો, જેમ કે 7 અથવા 7h30",
    "gym.hint.steps": "ગણતરી મોકલો, જેમ કે 8200 અથવા 8.2k",
    "gym.hint.offPlan": "પ્લાનની બહાર શું ખાધું એ લખો",
    "gym.hint.discomfort": "ક્યાં દુખાવો કે તકલીફ થઈ એ લખો",
    "gym.ph.bodyweight": "82.5",
    "gym.ph.sleep": "7h30",
    "gym.ph.steps": "8200",
    "gym.ph.offPlan": "2 સમોસા",
    "gym.ph.discomfort": "ઘૂંટણમાં દુખાવો",
    "gym.saved": "🏋️ તમારી શીટમાં લખી દીધું",
    "gym.date": "તારીખ:",
    "gym.bodyweight": "વજન",
    "gym.nutrition": "ખાણીપીણી",
    "gym.hydration": "પાણી",
    "gym.exercise": "કસરત",
    "gym.sleep": "ઊંઘ",
    "gym.steps": "ડગલાં",
    "gym.offPlan": "પ્લાનની બહાર",
    "gym.discomfort": "તકલીફ",
    "gym.resend": "ખોટું છે? ફરી મોકલો — એ જ દિવસની એ જ લાઇન બદલાઈ જશે.",
    "gym.ask":
      "🏋️ તમારું ચેક-ઇન એક જ મેસેજમાં મોકલો, જેમ કે:\n\n82.5kg, nutrition 4, પાણી 3, કસરત 5, 7 કલાક ઊંઘ, 8200 ડગલાં\n\nજે નહીં લખો એ ખાલી રહેશે.",
    "gym.nothing":
      "આમાં મને ચેક-ઇન મળ્યું નહીં. આ રીતે લખો: 82.5kg, nutrition 4, 7 કલાક ઊંઘ",
    "gym.badValue":
      "કોઈ એક આંકડો બરાબર ન લાગ્યો — ખાણીપીણી, પાણી અને કસરત 5 માંથી હોય છે. ફરી મોકલો?",
    "gym.notConfigured":
      "જિમ શીટ હજી જોડાઈ નથી. GYM_SHEET_URL અને GYM_SHEET_SECRET સેટ કરવા પડશે.",
    "gym.readFailed": "અત્યારે તમારી શીટ ખૂલી નહીં. કંઈ બદલાયું નથી — એક મિનિટ પછી ફરી મોકલો.",
    "gym.sheetFailed":
      "ચેક-ઇન વાંચી લીધું, પણ શીટમાં લખી ન શક્યો. કંઈ સેવ થયું નથી — એક મિનિટ પછી ફરી મોકલો.",
    "gym.noRow":
      "તમારી શીટમાં {date} ની કોઈ લાઇન નથી. કદાચ ટ્રેકરનું છેલ્લું અઠવાડિયું પૂરું થઈ ગયું છે.",
    "gym.error": "કંઈક ગડબડ થઈ. ફરી મોકલો?",
  },
};

export function gt(language, key, vars = {}) {
  const text = CATALOGS[language]?.[key] ?? CATALOGS.en[key] ?? key;

  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.hasOwn(vars, name) ? vars[name] : whole
  );
}

// Bound to one user's language, so a handler reads gtr("gym.saved").
export function gtr(user) {
  const language = user?.language ?? "en";

  return (key, vars) => gt(language, key, vars);
}

// What the AI is told to write the two free-text fields in. English adds no
// instruction at all, so an English user pays zero extra prompt tokens.
export const AI_LANGUAGE = {
  en: null,
  hi: "Hindi (Devanagari script)",
  gu: "Gujarati (Gujarati script)",
};

export { CATALOGS as GYM_CATALOGS };
