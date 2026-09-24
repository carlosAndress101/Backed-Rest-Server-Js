import type { RequestHandler, Router } from 'express';

import { CloudinaryClient, parseCloudinaryUrl } from './cloudinary.client';
import { createMediaController } from './media.controller';
import { createMediaRouter } from './media.routes';
import { createMediaService, type ImageModels } from './media.service';

export type { ImageModels, ImageRecordModel } from './media.service';

export interface MediaModuleDeps {
  /** User and Product belong to the users and products modules: src/app.ts passes them in (ADR-027). */
  models: ImageModels;
  authenticate: RequestHandler;
  /** config.media.cloudinaryUrl: the credentials, and the cloud whose assets GET may redirect to (AM-M3-1). */
  cloudinaryUrl: string;
}

/** P15: client → service → controller → router. src/app.ts mounts the result at /api/uploads (ADR-030). */
export function mediaModule(deps: MediaModuleDeps): Router {
  const credentials = parseCloudinaryUrl(deps.cloudinaryUrl);
  const service = createMediaService({
    models: deps.models,
    client: new CloudinaryClient(credentials),
    cloudName: credentials.cloudName,
  });
  return createMediaRouter({ controller: createMediaController(service), authenticate: deps.authenticate });
}
