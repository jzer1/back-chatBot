require('dotenv').config();

module.exports = {
  app: {
    port: process.env.PORT || 5000
  },
  google: {
    apiKey: process.env.GOOGLE_API_KEY
  },
  database: {
      uri: process.env.DATABASE_URL, // Esto es lo nuevo
  }
};
