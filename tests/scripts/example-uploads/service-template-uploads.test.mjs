// Every BNG Service template example file, uploaded with the backend's
// service-template flag on. See _describe-uploads.mjs.

import { SERVICE_TEMPLATE } from "../../../scripts/example-uploads/expectations.mjs";
import { describeUploads } from "./_describe-uploads.mjs";

describeUploads(SERVICE_TEMPLATE, "Example file uploads, BNG Service template");
