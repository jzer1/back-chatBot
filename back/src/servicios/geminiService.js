const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require("axios");
const cheerio = require("cheerio");
const { Pool } = require('pg');
const { google, database } = require('../../config');

// ---------------------------------------------------------------------------
// 1. VALIDACIÓN DE CONFIGURACIÓN
// ---------------------------------------------------------------------------

if (!google || !google.apiKey) {
    console.error("❌ ERROR: No se encontró la API Key de Google Generative AI.");
    process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. CONFIGURACIÓN DE BASE DE DATOS (Neon/PostgreSQL)
// ---------------------------------------------------------------------------

const pool = new Pool({
    connectionString: database.uri,
    ssl: { rejectUnauthorized: false }
});

// ---------------------------------------------------------------------------
// 3. CONFIGURACIÓN DEL MODELO DE IA
// ---------------------------------------------------------------------------

const genAI = new GoogleGenerativeAI(google.apiKey);
const modelName = "gemini-2.5-flash";

// ---------------------------------------------------------------------------
// 4. VARIABLE DE CACHÉ
// ---------------------------------------------------------------------------

let cachedBioContext = null;

// ---------------------------------------------------------------------------
// 5. SCRAPING DEL SITIO OFICIAL
// ---------------------------------------------------------------------------

async function scrapeOscarWebsite() {
    if (cachedBioContext) return cachedBioContext;

    try {
        const url = "https://senadoroscarhernandez.co/";
        const { data } = await axios.get(url, { timeout: 10000 });

        const $ = cheerio.load(data);
        let biografia = $("article, #content, .entry-content, main").text() 
                        || $("body").text();

        biografia = biografia.replace(/\s+/g, " ").trim();
        if (biografia.length > 4000) biografia = biografia.substring(0, 4000) + "...";

        cachedBioContext = { biografia: biografia.length > 50 ? biografia : "Información no disponible." };

        return cachedBioContext;
    } catch (error) {
        return { biografia: "No fue posible acceder al sitio oficial." };
    }
}

// ---------------------------------------------------------------------------
// 6. EXTRACCIÓN Y REGISTRO DE DATOS DEL USUARIO
// ---------------------------------------------------------------------------

async function analyzeAndSaveData(userId, text) {
    try {
        const model = genAI.getGenerativeModel({ model: modelName });

        const extractionPrompt = `
        Analiza el siguiente mensaje del usuario y extrae, si existen, los siguientes datos:
        • Nombre de la persona
        • Municipio o ciudad

        Mensaje: "${text}"

        Responde ÚNICAMENTE con este formato JSON:
        { "name": "Nombre o null", "municipality": "Municipio o null" }
        `;

        const result = await model.generateContent(extractionPrompt);
        const response = result.response.text().replace(/```json|```/g, '').trim();
        const extractedData = JSON.parse(response);

        if (extractedData.name || extractedData.municipality) {

            const updateQuery = `
                UPDATE users SET
                    name = COALESCE($1, name),
                    municipality = COALESCE($2, municipality)
                WHERE phone_number = $3
            `;

            await pool.query(updateQuery, [
                extractedData.name, 
                extractedData.municipality,
                String(userId)
            ]);

            console.log("💾 Datos del usuario actualizados:", extractedData);
        }
    } catch (error) {
        console.error("⚠️ Error en extracción de datos:", error.message);
    }
}

// ---------------------------------------------------------------------------
// 7. GENERACIÓN DE RESPUESTA PRINCIPAL DEL CHATBOT
// ---------------------------------------------------------------------------

async function getChatResponse(userId, userMessage) {
    if (!userMessage || userMessage.trim() === "") {
        return "Por favor, envíame un mensaje para poder ayudarte.";
    }

    const phoneNumber = String(userId);

    try {
        // 1. Registro o verificación del usuario
        await pool.query(
            `INSERT INTO users (phone_number) 
             VALUES ($1) 
             ON CONFLICT (phone_number) DO NOTHING`,
            [phoneNumber]
        );

        // 2. Extracción y guardado de datos del mensaje
        await analyzeAndSaveData(phoneNumber, userMessage);

        // 3. Obtener datos del usuario para personalizar la respuesta
        const { rows } = await pool.query(
            `SELECT name, municipality FROM users WHERE phone_number = $1`,
            [phoneNumber]
        );

        const userData = rows[0] || {};
        const userName = userData.name || "Ciudadano";
        const userMunicipalityString = userData.municipality 
            ? ` del municipio de ${userData.municipality}`
            : "";
        const userContextString = `Hablas con **${userName}**${userMunicipalityString}.`;

        // 4. Recuperación del historial (máximo 10 mensajes)
        const history = await pool.query(
            `SELECT role, message 
             FROM chat_history 
             WHERE phone_number = $1
             ORDER BY created_at ASC
             LIMIT 10`,
            [phoneNumber]
        );

        const formattedHistory = history.rows.map(h => ({
            role: h.role,
            parts: [{ text: h.message }]
        }));

        // 5. Scraping del sitio del candidato
        const scraped = await scrapeOscarWebsite();

        // 6. Construcción del prompt del sistema
        const systemInstruction = `
        ===========================================================
        ROL: Asistente principal de la campaña de Óscar Hernández Gualdrón.
        Hablas SIEMPRE en primera persona, como si fueras él.

        Usuario:
        ${userContextString}

        Biografía y contexto:
        ${scraped.biografia}

        TONO:
        • Amable, cercano, directo, auténtico.
        • Máximo 2 párrafos.
        • Cero discurso vacío; responde con claridad.

        POLÍTICAS:
        • Nunca entregues correos, teléfonos ni datos privados.
        • No te identifiques como IA; eres Óscar.
        • Si piden contacto: 
          “Para agendar una cita o contacto directo, usa mi web oficial.”

        OBJETIVO SECUNDARIO:
        • Invitar sutilmente al usuario a compartir nombre, teléfono y municipio 
          (solo después de resolver su duda).

        ===========================================================
        `;

        // 7. Inicialización del modelo con sistema + historial
        const model = genAI.getGenerativeModel({
            model: modelName,
            systemInstruction
        });

        const chat = model.startChat({ history: formattedHistory });
        const aiResponse = await chat.sendMessage(userMessage);
        const botMessage = aiResponse.response.text();

        // 8. Guardar historial
        const insertHistory = `
            INSERT INTO chat_history (phone_number, role, message)
            VALUES ($1, $2, $3)
        `;

        await Promise.all([
            pool.query(insertHistory, [phoneNumber, 'user', userMessage]),
            pool.query(insertHistory, [phoneNumber, 'model', botMessage])
        ]);

        return botMessage;

    } catch (error) {
        console.error("❌ Error en getChatResponse:", error);
        return "En este momento estoy recibiendo muchos mensajes. Intenta nuevamente en unos segundos.";
    }
}

module.exports = { getChatResponse };
