import * as path from "node:path";
import { type AllowedRoot, assertArtifactPathAllowed } from "../security/paths";
import { ADAPTER_PROJECTION_VERSION, buildLineageHash } from "../state/metadata";

export type ArtifactProjectionRefKind = "metadata" | "url";

export interface ProjectArtifactInput {
	readonly path: string;
	readonly allowedRoots: readonly AllowedRoot[];
	readonly artifactBaseUrl?: string;
	readonly label?: string;
}

export interface ProjectedArtifactRef {
	readonly kind: ArtifactProjectionRefKind;
	readonly id: string;
	readonly name: string;
	readonly metadata: {
		readonly gjc_adapter: {
			readonly projectionVersion: number;
			readonly artifactId: string;
			readonly artifactName: string;
			readonly lineageHash: string;
		};
	};
	readonly url?: string;
}

export async function projectArtifactRef(input: ProjectArtifactInput): Promise<ProjectedArtifactRef> {
	const realPath = await assertArtifactPathAllowed(input.path, input.allowedRoots);
	const artifactName = input.label ?? path.basename(realPath);
	const artifactId = buildLineageHash([realPath]).slice(0, 24);
	const metadata = {
		gjc_adapter: {
			projectionVersion: ADAPTER_PROJECTION_VERSION,
			artifactId,
			artifactName,
			lineageHash: buildLineageHash([artifactId, artifactName]),
		},
	};
	if (input.artifactBaseUrl === undefined) {
		return {
			kind: "metadata",
			id: artifactId,
			name: artifactName,
			metadata,
		};
	}
	return {
		kind: "url",
		id: artifactId,
		name: artifactName,
		metadata,
		url: buildArtifactUrl(input.artifactBaseUrl, artifactId, artifactName),
	};
}

function buildArtifactUrl(baseUrl: string, artifactId: string, artifactName: string): string {
	const url = new URL(baseUrl);
	const basePath = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
	url.pathname = `${basePath}${encodeURIComponent(artifactId)}/${encodeURIComponent(artifactName)}`;
	return url.toString();
}
