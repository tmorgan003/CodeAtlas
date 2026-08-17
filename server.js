const path = require('path');
const express = require('express');
const appsRouter = require('./src/routes/apps');
const browseRouter = require('./src/routes/browse');
const ownersRouter = require('./src/routes/owners');
const authRouter = require('./src/routes/auth');
const { attachUser } = require('./src/middleware/auth');
const { startScheduler } = require('./src/scheduler');

const app = express();
const PORT = process.env.PORT || 4173;

app.use(express.json());
app.use(attachUser);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/apps', appsRouter);
app.use('/api/browse', browseRouter);
app.use('/api/owners', ownersRouter);
app.use('/api/auth', authRouter);

app.listen(PORT, () => {
  console.log(`CodeAtlas running at http://localhost:${PORT}`);
  startScheduler();
});
