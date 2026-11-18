// Every legacy-template example file, uploaded with the backend's
// service-template flag off. See _describe-uploads.mjs.

import { LEGACY } from "../../../scripts/example-uploads/expectations.mjs";
import { describeUploads } from "./_describe-uploads.mjs";

describeUploads(LEGACY, "Example file uploads, legacy template");
