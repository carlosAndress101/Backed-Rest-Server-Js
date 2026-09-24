import type { RequestHandler, Router } from 'express';

import { CloudinaryClient, parseCloudinaryUrl } from './cloudinary.client';
import { createMediaController } from './media.controller';
import { createMediaRouter } from './media.routes';
import { createMediaService, type ImageRecordModel } from './media.service';

export type { ImageRecordModel } from './media.service';

export interface MediaModuleDeps {
  /** The users and products modules' models, injected by the composition root (§2.3 rule 4, ADR-027). */
  User: ImageRecordModel;
  Product: ImageRecordModel;
  authenticate: RequestHandler;
  /** config.media.cloudinaryUrl: the credentials, and the cloud whose assets GET may redirect to (AM-M3-1). */
  cloudinaryUrl: string;
}

/** P15: client → service → controller → router. src/app.ts mounts the result at /api/uploads (ADR-030). */
export function mediaModule(deps: MediaModuleDeps): Router {
  const credentials = parseCloudinaryUrl(deps.cloudinaryUrl);
  const service = createMediaService({
    User: deps.User,
    Product: deps.Product,
    client: new CloudinaryClient(credentials),
    cloudName: credentials.cloudName,
  });
  return createMediaRouter({ controller: createMediaController(service), authenticate: deps.authenticate });
}
