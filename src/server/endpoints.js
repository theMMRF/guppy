import esInstance from './es/index';
import { gitVersion, gitCommit } from './version';

export const statusRouter = async (req, res, next) => {
  try {
    await esInstance.getAllESIndices();
    res.send({ status: 'OK' });
  } catch (err) {
    next(err);
  }
  return 0;
};

export const versionRouter = async (req, res) => {
  res.send({
    version: gitVersion,
    commit: gitCommit,
  });
  return 0;
};
