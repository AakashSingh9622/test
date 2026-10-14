// DocuSoft ke remote SOAP-ish (.asmx) API se baat karne wala thin client -- sirf wahi functions
// jo admin login verify karne ke liye chahiye (docusoft-MCP/src/services/docusoft.js se ported,
// uske 30+ CRM/task functions me se sirf Json_GetAgreementList wala hissa).
const BASE_URL = "https://accountancy.mydocusoft.com/PracticeServices.asmx";

// DocuSoft endpoint ko POST karta hai aur non-200 response par readable error throw karta hai.
async function postRequest(endpoint, payload) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000), // never wait forever for DocuSoft (throws a TimeoutError)
  });

  if (!response.ok) {
    // .asmx errors ka asli reason response body me hota hai, status text me nahi -- isliye snippet bhi throw karo.
    let body = "";
    try {
      body = await response.text();
    } catch {
      // body read nahi ho payi -- ignore, status code hi kaafi hai
    }
    const snippet = body ? ` - ${body.slice(0, 500)}` : "";
    throw new Error(`DocuSoft API error: ${response.status} ${response.statusText}${snippet}`);
  }

  return response;
}

// DocuSoft ka response kabhi XML-wrapped string hota hai, kabhi double-encoded JSON ({d: "..."}) --
// ye function dono cases handle karke seedha usable JavaScript value deta hai.
async function parseResilientResponse(response) {
  const text = await response.text();

  // Step 1: agar <string>...</string> me wrapped hai to andar ka content nikaalo.
  const xmlMatch = text.match(/<string[^>]*>([\s\S]*?)<\/string>/);
  const coreString = xmlMatch ? xmlMatch[1].trim() : text.trim();

  try {
    const parsed = JSON.parse(coreString);

    // Step 2: ASMX ka classic "{ d: '...' }" wrapper -- d ke andar phir se JSON ho sakta hai.
    if (parsed && typeof parsed === "object" && "d" in parsed) {
      const dValue = parsed.d;
      if (typeof dValue === "string") {
        try {
          return JSON.parse(dValue);
        } catch {
          return dValue; // d string thi par JSON nahi -- raw string hi lauta do
        }
      }
      return dValue;
    }

    return parsed;
  } catch {
    // Bilkul bhi JSON nahi -- raw string hi lauta do, caller decide karega.
    return coreString;
  }
}

// Email + (base64-encoded) password se DocuSoft ka agreement list leta hai -- har row ek
// organisation/agreement hai jisse ye user juda hai, saath me uska admin flag bhi.
// NOTE: Json_GetFolders/Json_GetClientsByFolder yahan jaan-boojhkar nahi hain -- wo seedha
// frontend se DocuSoft ko call hote hain (reference: docusoftpractice project), is backend se
// nahi, isliye in dono ke liye koi function yahan nahi banaya gaya.
async function getAgreementList({ Email, password }) {
  const response = await postRequest(`${BASE_URL}/Json_GetAgreementList`, { Email, password });
  return parseResilientResponse(response);
}

module.exports = { getAgreementList };
