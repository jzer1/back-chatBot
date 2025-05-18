const express = require('express');
const config = require('./config');
const cors = require('cors');
const chatBotOpenIA = require('./src/rutas/chatRoutes');
const ruta = require('./src/rutas/rutas')

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Rutas
app.use('/api', chatBotOpenIA);
app.use('/api', ruta);  

// Configurar el puerto
app.set('port', config.app.port);

const path = require('path');

// Servir archivos estáticos desde "public"
app.use(express.static(path.join(__dirname, 'public')));


module.exports = app;
