import express from 'express';
import authMiddleware from '../middleware/auth.js';
import { createUserClient } from '../config/supabase.js';

const router = express.Router();
router.use(authMiddleware);

router.get('/messages', async (req, res) => {
  try {
    const supabase = createUserClient(req.userJWT ?? '');

    const roomIdsParam = req.query.roomIds;

    if (!roomIdsParam || typeof roomIdsParam !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing roomIds' });
    }

    const roomIds = JSON.parse(roomIdsParam);

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .in('room_id', roomIds);

    if (error) {
      console.log(error);
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      messages: data,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false });
  }
});

export default router;
