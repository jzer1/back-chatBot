const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const { Pool } = require("pg");
const { google, database } = require("../../config");

// =============================================================================
// 1. CONFIGURACIÓN CENTRALIZADA (El "Cerebro" de los ajustes)
// =============================================================================
const CONFIG = {
  CAMPAIGN: {
    CANDIDATE_NAME: "Óscar Hernández",
    BOT_NAME: "Cami",
    FORM_URL:
      "https://oscarhernandez-respaldame.com/formulario/participa-y-gana-un-viaje-a-san-andres-islas",
    BIO_SNIPPET:
      "Óscar Hernández es un líder comprometido con la comunidad, promotor del turismo y el desarrollo social. Esta campaña busca premiar el apoyo ciudadano con un viaje a San Andrés.",
  },
  AI: {
    MODELS: ["gemini-1.5-flash", "gemini-2.0-flash-exp"],
    MAX_RETRIES: 2,
    HISTORY_LIMIT: 10,
    SAFETY_SETTINGS: [
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
      },
    ],
  },
  DELAYS: {
    RETRY_BASE_MS: 1000,
    JITTER_MS: 500,
  },
};

// =============================================================================
// 2. INICIALIZACIÓN DE SERVICIOS
// =============================================================================
if (!google?.apiKey) {
  console.error("❌ FATAL: API Key de Google no encontrada.");
  process.exit(1);
}
if (!database?.uri) {
  console.error("❌ FATAL: URI de Base de Datos no encontrada.");
  process.exit(1);
}

const pool = new Pool({ connectionString: database.uri, ssl: { rejectUnauthorized: false } });
const genAI = new GoogleGenerativeAI(google.apiKey);

// =============================================================================
// 3. UTILIDADES (Helpers)
// =============================================================================
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const Utils = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),

  normalize: (text) =>
    String(text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim(),

  isBlank: (text) => !text || String(text).trim() === "",

  // Hora Colombia (sin -5 manual)
  getTimeGreeting: () => {
    const hour = Number(
      new Intl.DateTimeFormat("es-CO", {
        timeZone: "America/Bogota",
        hour: "2-digit",
        hour12: false,
      }).format(new Date())
    );
    if (hour < 12) return "Buenos días";
    if (hour < 18) return "Buenas tardes";
    return "Buenas noches";
  },

  // Saludo mandatorio SIEMPRE (sin duplicar si ya viene saludando)
  ensureGreeting: (text, userName) => {
    const raw = String(text || "").trim();
    if (!raw) return raw;

    const t = Utils.normalize(raw);
    const alreadyGreets = /^(¡?\s*(hola|buenos dias|buenas tardes|buenas noches|saludos|que tal)\b)/i.test(
      t
    );
    if (alreadyGreets) return raw;

    const name = userName ? ` ${userName}` : "";
    const g = Utils.getTimeGreeting();
    return `¡${g}${name}! 👋\n\n${raw}`;
  },

  // Quita el link aunque venga con/sin https y con texto pegado
  stripLink: (text) => {
    const url = CONFIG.CAMPAIGN.FORM_URL;
    const domain = url.split("/")[2];
    const re = new RegExp(`\\s*(https?:\\/\\/)?${escapeRegex(domain)}\\S*\\s*`, "gi");
    return String(text || "").replace(re, " ").replace(/\s{2,}/g, " ").trim();
  },
};

// =============================================================================
// 4. ANALIZADOR DE INTENCIONES (NLP Básico)
// =============================================================================
const IntentAnalyzer = {
  isAlreadyRegistered: (msg) => {
    const t = Utils.normalize(msg);
    return [
      "ya me registre",
      "ya me inscribi",
      "ya lo llene",
      "ya participe",
      "listo el registro",
      "ya quedo",
    ].some((p) => t.includes(p));
  },

  // Incluye: pide link, quiere inscribirse, o no lo ve (no/no lo veo/etc)
  isResendRequest: (msg) => {
    const t = Utils.normalize(msg);
    const patterns = [
      "envia el link",
      "mandame el enlace",
      "reenvia",
      "reenviame",
      "otra vez",
      "de nuevo",
      "pasa el link",
      "pasa el enlace",
      "enlace",
      "link",

      "quiero inscribirme",
      "quiero participar",
      "me quiero anotar",
      "como me inscribo",
      "a donde entro",
      "cual es el link",
      "donde esta el link",
      "donde esta el enlace",

      "no lo veo",
      "no aparece",
      "no me llego",
      "no",
      "tampoco",
      "nada",
    ];
    if (t === "no" || t === "no lo veo") return true;
    return patterns.some((p) => t.includes(p));
  },

  isGratitudeOrFarewell: (msg) => {
    const t = Utils.normalize(msg);
    return [
      "gracias",
      "muy amable",
      "agradecido",
      "hasta luego",
      "chao",
      "nos vemos",
      "bendiciones",
      "feliz dia",
    ].some((p) => t.includes(p));
  },
};

// =============================================================================
// 5. CAPA DE DATOS (Database Layer)
// =============================================================================
const DB = {
  hasAnyHistory: async (phone) => {
    const res = await pool.query(`SELECT 1 FROM chat_history WHERE phone_number = $1 LIMIT 1`, [
      phone,
    ]);
    return res.rowCount > 0;
  },

  ensureUserExists: async (phone) => {
    await pool.query(
      `INSERT INTO users (phone_number) VALUES ($1) ON CONFLICT (phone_number) DO NOTHING`,
      [phone]
    );
  },

  getUserData: async (phone) => {
    const { rows } = await pool.query(`SELECT name, municipality FROM users WHERE phone_number = $1`, [
      phone,
    ]);
    return rows[0] || { name: null, municipality: null };
  },

  hasLinkBeenSent: async (phone) => {
    const domain = CONFIG.CAMPAIGN.FORM_URL.split("/")[2];
    const res = await pool.query(
      `SELECT 1 FROM chat_history WHERE phone_number = $1 AND role = 'model' AND message LIKE $2 LIMIT 1`,
      [phone, `%${domain}%`]
    );
    return res.rowCount > 0;
  },

  getHistory: async (phone) => {
    const res = await pool.query(
      `SELECT role, message FROM chat_history WHERE phone_number = $1 ORDER BY created_at DESC LIMIT $2`,
      [phone, CONFIG.AI.HISTORY_LIMIT]
    );
    return res.rows.reverse().map((h) => ({ role: h.role, parts: [{ text: h.message }] }));
  },

  saveInteraction: async (phone, userMsg, botMsg) => {
    const query = `INSERT INTO chat_history (phone_number, role, message) VALUES ($1, $2, $3)`;
    await Promise.all([
      pool.query(query, [phone, "user", userMsg]),
      pool.query(query, [phone, "model", botMsg]),
    ]);
  },
};

// =============================================================================
// 6. GESTOR DE RESPUESTAS MANUALES (Fallbacks)
// =============================================================================
function getFallbackResponse(scenario, userName) {
  const url = CONFIG.CAMPAIGN.FORM_URL;

  const libraries = {
    greeting: [
      `Es un gusto saludarte. Para participar en el sorteo del viaje a San Andrés, por favor completa el siguiente formulario:`,
      `Qué alegría que quieras participar. Para inscribirte oficialmente, ingresa tus datos aquí:`,
      `No te quedes por fuera del sorteo. Regístrate en este enlace:`,
    ],
    resend: [
      `Con mucho gusto. Aquí tienes nuevamente el enlace de inscripción 👇:`,
      `Claro que sí. Te comparto el enlace de nuevo para que puedas registrarte sin problemas 📝:`,
      `Por supuesto, aquí te envío el enlace para que puedas participar:`,
    ],
    alreadySent: [
      `Te compartí el enlace en el mensaje anterior 👆. ¿Pudiste verlo?`,
      `El link de inscripción se encuentra un poco más arriba en este chat 👆.`,
      `Ya te había enviado el enlace anteriormente. Revísalo arriba 👆 y, si no te funciona, avísame.`,
    ],
    farewell: [
      `Con mucho gusto. Estamos para servirle. ¡Mucha suerte en el sorteo! 🎉`,
      `Ha sido un placer atenderte. Quedamos atentos. 👋`,
      `¡Gracias a ti por participar! Esperamos que seas el ganador/a. ¡Bendiciones! ✨`,
    ],
  };

  const lib = libraries[scenario] || libraries.greeting;
  const text = lib[Math.floor(Math.random() * lib.length)];

  // ✅ Saludo mandatorio SIEMPRE
  const withGreeting = Utils.ensureGreeting(text, userName);

  // ✅ Link solo cuando corresponde
  if (scenario === "alreadySent" || scenario === "farewell") return withGreeting;
  return `${withGreeting}\n${url}`;
}

// =============================================================================
// 7. MOTOR DE IA (Generación y Reintentos)
// =============================================================================
async function generateAIResponse(systemInstruction, history, userMessage) {
  let lastError = null;

  for (const modelName of CONFIG.AI.MODELS) {
    for (let attempt = 0; attempt <= CONFIG.AI.MAX_RETRIES; attempt++) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction,
          safetySettings: CONFIG.AI.SAFETY_SETTINGS,
        });

        const chat = model.startChat({ history });
        const result = await chat.sendMessage(userMessage);
        const text = result.response.text();

        if (!Utils.isBlank(text)) return { ok: true, text };
      } catch (err) {
        lastError = err;
        const status = err.status || 500;

        if (status === 400 || status === 404) break;

        if ((status === 429 || status === 503) && attempt < CONFIG.AI.MAX_RETRIES) {
          await Utils.sleep(CONFIG.DELAYS.RETRY_BASE_MS + Math.random() * CONFIG.DELAYS.JITTER_MS);
          continue;
        }
        break;
      }
    }
  }
  return { ok: false, error: lastError };
}

// =============================================================================
// 8. CONTROLADOR PRINCIPAL (Main Handler)
// =============================================================================
async function getChatResponse(userId, userMessage) {
  const phone = String(userId);

  // --- A. Validación Inicial ---
  const hasAnyHistory = await DB.hasAnyHistory(phone);

  // Si llega vacío, respondemos con fallback (saludo siempre)
  if (Utils.isBlank(userMessage)) {
    return getFallbackResponse(hasAnyHistory ? "alreadySent" : "greeting", null);
  }

  try {
    // --- B. Gestión de Usuarios y Datos ---
    await DB.ensureUserExists(phone);
    const userData = await DB.getUserData(phone);
    const history = await DB.getHistory(phone);

    // --- C. Estado (Reglas de Negocio) ---
    const state = {
      isFirstInteraction: !hasAnyHistory,
      linkSentBefore: await DB.hasLinkBeenSent(phone),
      isRegistered: IntentAnalyzer.isAlreadyRegistered(userMessage),
      wantsLink: IntentAnalyzer.isResendRequest(userMessage),
      isFarewellRaw: IntentAnalyzer.isGratitudeOrFarewell(userMessage),
    };

    // “Despedida exclusiva” = agradece/se despide, pero NO pide link y NO dice que ya se registró
    state.isFarewellExclusive = state.isFarewellRaw && !state.wantsLink && !state.isRegistered;

    // Bloqueo de link solo si es despedida/agradecimiento exclusivo o ya registrado
    const shouldBlockLink = state.isRegistered || state.isFarewellExclusive;

    // Link obligatorio si: primera interacción O lo pide/“no lo veo”/“quiero participar”
    const shouldSendLink = !shouldBlockLink && (state.isFirstInteraction || state.wantsLink);

    // --- D. Prompt del Sistema ---
    const systemInstruction = `
ROL: Eres ${CONFIG.CAMPAIGN.BOT_NAME}, asistente oficial de la campaña de ${CONFIG.CAMPAIGN.CANDIDATE_NAME}.
BIO CONTEXTO: ${CONFIG.CAMPAIGN.BIO_SNIPPET}

REGLA CERO (MANDATORIA):
- SIEMPRE inicia tu respuesta con un saludo (ej: "¡Hola!", "¡Buenos días!"), incluso si vas a pegar el enlace o si solo respondes cortesía.

TONO DE VOZ:
- Cordial, paciente y servicial (Usa "Con gusto", "Claro que sí").
- Formal pero cercano (Usa emojis moderados: 👋, ✅, 📩).
- Si el usuario agradece, sé muy amable al despedirte.

OBJETIVO PRINCIPAL:
Facilitar la inscripción en: ${CONFIG.CAMPAIGN.FORM_URL}

ESTADO DEL USUARIO:
- ¿Primera interacción?: ${state.isFirstInteraction ? "SÍ" : "NO"}
- ¿Ya tiene el link?: ${state.linkSentBefore ? "SÍ" : "NO"}
- ¿Está pidiendo el link?: ${state.wantsLink ? "SÍ" : "NO"}
- ¿Ya se registró?: ${state.isRegistered ? "SÍ" : "NO"}

INSTRUCCIONES LÓGICAS (PRIORIDAD ALTA):
1) SI ES PRIMERA INTERACCIÓN:
   -> Entrega el enlace SIEMPRE.

2) SI PIDE EL LINK, DICE "QUIERO INSCRIBIRME", "QUIERO PARTICIPAR" O DICE "NO LO VEO":
   -> Entrega el enlace SIEMPRE. Di: "Aquí tiene el enlace 👇" y pega el link.

3) SI DICE "YA ME REGISTRÉ":
   -> Felicítalo, agradece el apoyo y desea suerte. NO pegues el link.

4) SI ES AGRADECIMIENTO/DESPEDIDA (EXCLUSIVO):
   -> Responde con cortesía ("Es un placer atenderle", "Mucha suerte", "Feliz día").
   -> NO pegues el link.

5) SI SALUDA Y YA TIENE EL LINK (y no lo pide):
   -> Recuérdale amablemente que el link está en el mensaje anterior 👆.
   -> NO pegues el link de nuevo.

NOTA: Ante la duda de si el usuario tiene el link o no, ENVÍALO.
`;

    // --- E. Generación de Respuesta ---
    const aiResult = await generateAIResponse(systemInstruction, history, userMessage);

    let finalResponse = "";

    if (aiResult.ok) {
      finalResponse = aiResult.text;

      // --- F. Post-Procesamiento (Inyectar/Quitar Link + Saludo) ---
      const domain = CONFIG.CAMPAIGN.FORM_URL.split("/")[2];
      const linkRegex = new RegExp(`(https?:\\/\\/)?${escapeRegex(domain)}\\S*`, "i");
      const hasLinkInText = linkRegex.test(finalResponse);

      if (shouldSendLink && !hasLinkInText) {
        finalResponse += `\n\nAquí le adjunto el enlace de inscripción 👇:\n${CONFIG.CAMPAIGN.FORM_URL}`;
      } else if (!shouldSendLink && hasLinkInText) {
        finalResponse = Utils.stripLink(finalResponse);
      }

      // ✅ Saludo mandatorio SIEMPRE (aunque la IA lo olvide)
      finalResponse = Utils.ensureGreeting(finalResponse, userData?.name);
    } else {
      // --- G. Fallback Manual ---
      let type = "greeting";
      if (state.isRegistered) type = "farewell";
      else if (state.isFarewellExclusive) type = "farewell";
      else if (shouldSendLink) type = "resend";
      else type = "alreadySent";

      finalResponse = getFallbackResponse(type, userData?.name);
    }

    // --- H. Guardado y Retorno ---
    finalResponse = finalResponse.replace(/\n{3,}/g, "\n\n").trim();

    await DB.saveInteraction(phone, userMessage, finalResponse);
    return finalResponse;
  } catch (error) {
    console.error("❌ Error Crítico en Bot:", error);
    // Último recurso: saludo + link (greeting ya lo incluye)
    return getFallbackResponse("greeting", null);
  }
}

module.exports = { getChatResponse };
