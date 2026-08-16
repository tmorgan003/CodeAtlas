const path = require('path');
const express = require('express');
const appsRouter = require('./src/routes/apps');
const browseRouter = require('./src/routes/browse');
const { startScheduler } = require('./src/scheduler');

const app = express();
const PORT = process.env.PORT || 4173;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/apps', appsRouter);
app.use('/api/browse', browseRouter);

app.listen(PORT, () => {
  console.log(`CodeAtlas running at http://localhost:${PORT}`);
  startScheduler();
});
