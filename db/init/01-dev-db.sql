-- Separate database for running the app on the host with `npm run dev`
-- (its GovDocs repos live in ./data, the container's on a volume).
CREATE DATABASE housegov_dev OWNER housegov;
