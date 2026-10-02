import type { RequestHandler } from 'express';
import type { UploadedFile } from 'express-fileupload';

import { envelope } from '../../core/http/envelope';
import type { MediaParams } from './media.schemas';
import type { MediaService } from './media.service';

export type MediaController = ReturnType<typeof createMediaController>;

/** Thin handlers: read the input validate and requireImage already checked, make one service call, answer. */
export function createMediaController(service: MediaService) {
  const replaceImage: RequestHandler = async (req, res) => {
    const { collection, id } = req.params as MediaParams;
    // requireImage let exactly one file through, in the "file" field.
    const { tempFilePath } = req.files!.file as UploadedFile;
    const record = await service.replaceImage(collection, id, tempFilePath, req.log);
    res.status(200).json(envelope(record));
  };

  const showImage: RequestHandler = async (req, res) => {
    const { collection, id } = req.params as MediaParams;
    res.redirect(302, await service.imageUrl(collection, id));
  };

  return { replaceImage, showImage };
}
