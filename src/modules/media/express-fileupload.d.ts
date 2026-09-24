// express-fileupload ships no types and @types/express-fileupload is not a dependency: the part media uses.
declare module 'express-fileupload' {
  import type { RequestHandler } from 'express';

  namespace fileUpload {
    interface UploadedFile {
      name: string;
      size: number;
      mimetype: string;
      truncated: boolean;
      /** Set because the media parser uses temp files, never memory. */
      tempFilePath: string;
    }
    type FileArray = Record<string, UploadedFile | UploadedFile[]>;
    interface Options {
      useTempFiles?: boolean;
      tempFileDir?: string;
      createParentPath?: boolean;
      limits?: { fileSize?: number; files?: number };
      abortOnLimit?: boolean;
      limitHandler?: RequestHandler;
    }
  }

  function fileUpload(options?: fileUpload.Options): RequestHandler;

  global {
    namespace Express {
      interface Request {
        /** Set by express-fileupload, which only the media upload route runs (C10). */
        files?: fileUpload.FileArray | null;
      }
    }
  }

  export = fileUpload;
}
