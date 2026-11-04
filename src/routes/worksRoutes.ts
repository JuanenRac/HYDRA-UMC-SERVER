// =============================================================================
// HYDRA-UMC-SERVER - src/routes/worksRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Saving work files and the model submission catalogue, moved out of server.ts unchanged.
import express from "express";
import { apiRateLimiter } from "../auth";
import path from "path";
import fs from "fs";
import { realSettings, slugify, isPathInside } from "../serverPolicy";
import { RESERVED_DATA_FILENAMES } from "./staticRoutes";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface WorksRouteDeps {
  authenticate: Middleware;
  requireAdmin: Middleware;
  infoAccess: Middleware;
  dataPath: string;
  getSettings: () => any;
  /** The audit record; a model submission writes one entry (account, address, name, category, whether it replaces; never the model). */
  audit?: { record: (event: any) => unknown };
}

export function registerWorksRoutes(app: express.Express, deps: WorksRouteDeps): { resolveWithinDataDir: (...segments: string[]) => string | null } {
  const { authenticate, requireAdmin, infoAccess, dataPath, getSettings, audit } = deps;
  // authenticate (not requireAdmin): saving/loading a robot's own
  // trajectory files is an operational action, same tier as POST
  // /api/robot/:id/command below - it writes to disk so it must not be
  // reachable by a fully anonymous caller, but an "operator" account
  // shouldn't need admin rights just to save a work file. This route was
  // previously missing ANY auth check at all (every other disk-writing
  // route in this file requires at least authenticate) - see
  // src/components/AuthGate.tsx's own header comment, which already
  // enumerated POST /api/settings and POST /api/robot/:id/command as the
  // writes gated behind login and never mentioned this one.
  app.post("/api/upload-work", apiRateLimiter, authenticate, (req, res) => {
    try {
      const { folderPath, fileName, content } = req.body || {};
      if (typeof folderPath !== "string" || typeof fileName !== "string") {
        return res.status(400).json({ error: "folderPath and fileName required" });
      }

      // Sanitize folderPath to prevent Path Traversal
      const sanitizedFolderPath = folderPath.replace(/\.\./g, "");
      const absoluteFolderPath = path.resolve(dataPath, sanitizedFolderPath);

      if (!isPathInside(dataPath, absoluteFolderPath)) {
        return res.status(403).json({ error: "Access denied: Path traversal detected" });
      }

      // fileName only ever needed the SAME guard folderPath gets above, but
      // never got it - it was joined into the write path as-is, so a value
      // like "../../../../etc/cron.d/evil" would walk the write target back
      // out of absoluteFolderPath (already validated to sit inside dataPath)
      // and out of dataPath entirely, the exact path-traversal risk the
      // folderPath check exists to stop. path.basename() strips any
      // directory component - "../x", "/etc/passwd", and embedded
      // separators all collapse to a bare filename that can only land
      // inside the already-validated folder.
      const safeFileName = path.basename(fileName);
      if (!safeFileName || safeFileName === "." || safeFileName === "..") {
        return res.status(400).json({ error: "Invalid file name" });
      }

      // The folderPath guard above stops ".." from escaping
      // dataPath, but folderPath is caller-controlled and can legitimately
      // resolve to dataPath's OWN root (folderPath: "" or "."), which
      // startsWith(dataPath) allows (dataPath starts with itself). An
      // authenticate()-only route (this one is intentionally NOT
      // requireAdmin - see the comment above this route - an "operator"
      // account can reach it) combined with fileName: "users.json" would
      // then write straight over the real data/users.json (password
      // hashes) or data/settings.json - turning "save a work file" into a
      // privilege-escalation primitive for an operator account. Not a "../"
      // traversal in the classic sense (absoluteFolderPath genuinely never
      // leaves dataPath), which is why the existing traversal check alone
      // didn't catch it. Blocking the 3 reserved filenames regardless of
      // which folder they'd land in closes this without restricting the
      // legitimate use case (arbitrary folderPath values under dataPath,
      // including settings.worksPaths).
      if (RESERVED_DATA_FILENAMES.has(safeFileName.toLowerCase())) {
        return res.status(403).json({ error: "Access denied: reserved file name" });
      }

      if (!fs.existsSync(absoluteFolderPath)) {
        fs.mkdirSync(absoluteFolderPath, { recursive: true });
      }

      const filePath = path.join(absoluteFolderPath, safeFileName);
      fs.writeFileSync(filePath, JSON.stringify(content, null, 2));

      // update index.json
      const indexPath = path.join(absoluteFolderPath, "index.json");
      let index: string[] = [];
      if (fs.existsSync(indexPath)) {
        index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      }
      if (!index.includes(safeFileName)) {
        index.push(safeFileName);
        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
      }

      res.json({ success: true });
    } catch (e: any) {
      console.error("Error uploading work", e);
      res.status(500).json({ error: e.message || "Error saving file" });
    }
  });

  // =========================================================================
  // Model submissions - the server side of HYDRA-UMC-EDITOR-URDF
  // (github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF). That project
  // is a graphical URDF creator/editor meant to push a finished robot/
  // machine (3D meshes + kinematics) straight into this server's own
  // catalog instead of the manual "hand-add files to public/models/" pass
  // every robot in this ecosystem's own history got so far. Off by default
  // (settings.modelSubmissions.enabled) - an admin opts in from Config,
  // same gate philosophy as remoteAccess above: nothing lands on disk
  // just because a client asked.
  // =========================================================================
  const MODEL_SUBMISSIONS_INDEX_PATH = () => path.join(dataPath, "model_submissions.json");

  function readModelSubmissionsIndex(): any[] {
    try {
      const raw = fs.readFileSync(MODEL_SUBMISSIONS_INDEX_PATH(), "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeModelSubmissionsIndex(entries: any[]): void {
    fs.writeFileSync(MODEL_SUBMISSIONS_INDEX_PATH(), JSON.stringify(entries, null, 2), "utf-8");
  }

  // slugify now lives in ./serverPolicy (see that module's own header
  // comment) - moved unchanged so it's directly unit-testable.

  // Same path-traversal guard POST /api/upload-work already applies above,
  // reused here for both the submission folder itself and every individual
  // mesh filename inside it (a malicious/malformed filename like
  // "../../../etc/passwd" must not escape the model's own folder either).
  function resolveWithinDataDir(...segments: string[]): string | null {
    const sanitized = segments.map(s => String(s).replace(/\.\./g, ""));
    const resolved = path.resolve(dataPath, ...sanitized);
    return isPathInside(dataPath, resolved) ? resolved : null;
  }

  const MAX_ATTRIBUTION_CHARS = 8000;

  app.post("/api/models/submit", apiRateLimiter, authenticate, requireAdmin, (req: any, res) => {
    const who = req.user;
    const note = (outcome: "ok" | "refused" | "failed", detail: Record<string, unknown>) => {
      try { audit?.record({ type: "model-submit", outcome, userId: who?.id, username: who?.username, ip: req.ip, detail }); } catch { /* the audit never breaks the route */ }
    };
    try {
      const submissions = realSettings(getSettings())?.modelSubmissions;
      if (!submissions?.enabled) {
        note("refused", { reason: "submissions-disabled" });
        return res.status(403).json({ error: "This server isn't accepting model submissions right now - enable it from Config > Models first." });
      }
      const { name, category, urdfFilename, urdfXml, meshFiles, overwrite, attribution } = req.body || {};
      if (typeof name !== "string" || !name.trim() || typeof category !== "string" || typeof urdfXml !== "string") {
        return res.status(400).json({ error: "name, category, and urdfXml are required" });
      }
      // The licence and credit of the meshes travel in their own field (the caller also keeps them as a comment at the top of the URDF).
      // Optional unless the operator turned `requireAttribution` on; always text, trimmed and capped, never interpreted.
      if (attribution !== undefined && attribution !== null && typeof attribution !== "string") {
        return res.status(400).json({ error: "attribution must be text" });
      }
      const attributionText = typeof attribution === "string" ? attribution.trim() : "";
      if (attributionText.length > MAX_ATTRIBUTION_CHARS) {
        return res.status(400).json({ error: `attribution is too long (max ${MAX_ATTRIBUTION_CHARS} characters)` });
      }
      if (submissions.requireAttribution === true && !attributionText) {
        note("refused", { reason: "attribution-required" });
        return res.status(400).json({ error: "This server requires the licence and credit of the model in the attribution field." });
      }
      const slug = slugify(name);
      const destFolderRel = String(submissions.destinationFolder || "models/submitted");
      const destFolder = resolveWithinDataDir(destFolderRel, category, slug);
      if (!destFolder) {
        return res.status(403).json({ error: "Access denied: path traversal detected" });
      }

      const index = readModelSubmissionsIndex();
      const existing = index.find((e: any) => e.slug === slug && e.category === category);
      if (existing && !overwrite) {
        note("refused", { reason: "exists", name: slug, category, replaces: false });
        return res.status(409).json({ error: `A model named "${slug}" already exists in category "${category}" - resubmit with overwrite:true to replace it, or pick a different name.`, slug });
      }

      // Same class of bug as #016 above, found while fixing it: unlike
      // every mesh filename below (already routed through
      // resolveWithinDataDir's own dataPath-prefix check),
      // urdfFilename came straight from req.body and was joined onto
      // destFolder with no guard at all - a value like
      // "../../../../users.json" would walk the write target back out of
      // destFolder (and out of dataPath) via ordinary path.join()
      // normalization. This route is requireAdmin (unlike upload-work), so
      // the caller is already trusted, but there's no reason an admin
      // token should be able to write outside this model's own folder
      // just by naming its URDF file oddly - path.basename() strips any
      // directory component the same way upload-work's fileName already
      // does.
      const MAX_MESH_FILES = 200;
      const MAX_MESH_BYTES = 32 * 1024 * 1024;
      const MESH_EXTENSIONS = new Set([".stl", ".dae", ".obj", ".glb", ".gltf", ".mtl", ".ply", ".png", ".jpg", ".jpeg"]);
      if (meshFiles !== undefined && meshFiles !== null) {
        if (!Array.isArray(meshFiles) || meshFiles.length > MAX_MESH_FILES) {
          return res.status(400).json({ error: `meshFiles must be an array of at most ${MAX_MESH_FILES} files` });
        }
        for (const mf of meshFiles) {
          if (!mf || typeof mf.filename !== "string" || typeof mf.base64 !== "string") continue;
          if (!MESH_EXTENSIONS.has(path.extname(mf.filename).toLowerCase())) {
            return res.status(400).json({ error: `mesh file type not allowed: ${path.extname(mf.filename) || "(none)"}` });
          }
          if (Math.floor(mf.base64.length * 3 / 4) > MAX_MESH_BYTES) {
            return res.status(400).json({ error: `mesh file too large (max ${MAX_MESH_BYTES / (1024 * 1024)} MB): ${mf.filename}` });
          }
        }
      }
      const safeUrdfFilename = path.basename(String(urdfFilename || "")) || `${slug}.urdf`;
      fs.mkdirSync(destFolder, { recursive: true });
      fs.writeFileSync(path.join(destFolder, safeUrdfFilename), urdfXml, "utf-8");

      const attributionFile = path.join(destFolder, "ATTRIBUTION.txt");
      if (attributionText) {
        fs.writeFileSync(attributionFile, attributionText + "\n", "utf-8");
      } else if (fs.existsSync(attributionFile)) {
        fs.rmSync(attributionFile, { force: true }); // an overwrite without credit must not keep the credit of the old model
      }

      const meshDir = path.join(destFolder, "meshes");
      if (Array.isArray(meshFiles) && meshFiles.length > 0) {
        fs.mkdirSync(meshDir, { recursive: true });
        for (const mf of meshFiles) {
          if (!mf || typeof mf.filename !== "string" || typeof mf.base64 !== "string") continue;
          const meshPath = resolveWithinDataDir(destFolderRel, category, slug, "meshes", mf.filename);
          if (!meshPath) continue; // silently skip a traversal attempt in one file rather than aborting the whole submission
          fs.writeFileSync(meshPath, Buffer.from(mf.base64, "base64"));
        }
      }

      const entry = { slug, name: name.trim(), category, submittedAt: new Date().toISOString(), folder: path.relative(dataPath, destFolder).split(path.sep).join("/"), ...(attributionText ? { attribution: attributionText } : {}) };
      const nextIndex = existing ? index.map((e: any) => (e.slug === slug && e.category === category ? entry : e)) : [...index, entry];
      writeModelSubmissionsIndex(nextIndex);

      note("ok", { name: slug, category, replaces: !!existing, meshFiles: Array.isArray(meshFiles) ? meshFiles.length : 0, ...(attributionText ? { attributionChars: attributionText.length } : {}) });
      res.json({ success: true, slug });
    } catch (e: any) {
      console.error("Error accepting model submission", e);
      note("failed", { reason: "write-error" });
      res.status(500).json({ error: e.message || "Error saving submitted model" });
    }
  });

  app.get("/api/models", apiRateLimiter, infoAccess, (req, res) => {
    res.json({ models: readModelSubmissionsIndex() });
  });

  app.get("/api/models/:category/:slug/download", apiRateLimiter, infoAccess, (req, res) => {
    const submissions = realSettings(getSettings())?.modelSubmissions;
    if (!submissions?.enabled) {
      return res.status(403).json({ error: "This server isn't accepting model submissions right now - enable it from Config > Models first." });
    }
    const { category, slug } = req.params;
    const index = readModelSubmissionsIndex();
    const entry = index.find((e: any) => e.slug === slug && e.category === category);
    if (!entry) {
      return res.status(404).json({ error: "No such submitted model" });
    }
    const folder = resolveWithinDataDir(entry.folder);
    if (!folder || !fs.existsSync(folder)) {
      return res.status(404).json({ error: "Submitted model is recorded in the index but its files are missing on disk" });
    }
    try {
      const files = fs.readdirSync(folder);
      const urdfFile = files.find(f => f.endsWith(".urdf"));
      const urdfXml = urdfFile ? fs.readFileSync(path.join(folder, urdfFile), "utf-8") : "";
      const meshDir = path.join(folder, "meshes");
      const meshFiles = fs.existsSync(meshDir)
        ? fs.readdirSync(meshDir).map(filename => ({ filename, base64: fs.readFileSync(path.join(meshDir, filename)).toString("base64") }))
        : [];
      res.json({ slug, name: entry.name, category, urdfFilename: urdfFile || "", urdfXml, meshFiles, ...(entry.attribution ? { attribution: entry.attribution } : {}) });
    } catch (e: any) {
      console.error("Error reading submitted model", e);
      res.status(500).json({ error: e.message || "Error reading submitted model" });
    }
  });

  return { resolveWithinDataDir };
}
