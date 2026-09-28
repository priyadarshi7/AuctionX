import { createPresignedUpload, type PresignedUpload, type UploadContentType } from '../../infrastructure/storage/presign';

// A thin pass-through today — kept as its own service function (rather than
// calling the infrastructure layer directly from the controller) matching
// every other module's layering, so a future business rule here (e.g. a
// per-seller daily upload quota) has an obvious place to live without
// restructuring the module.
export function requestUploadUrl(sellerId: string, contentType: UploadContentType): Promise<PresignedUpload> {
  return createPresignedUpload(sellerId, contentType);
}
