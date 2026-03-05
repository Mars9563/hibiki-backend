import express from 'express';
import authMiddleware from '../middleware/auth.js';
import { createUserClient } from '../config/supabase.js';
const router = express.Router();
router.use(authMiddleware);

router.get('/me', async (req, res) => {
  try {
    const supabase = createUserClient(req.userJWT ?? '');

    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', req.userId);

    res.status(200).json(data);
  } catch (error) {
    console.log(error);
  }
});

export default router;
