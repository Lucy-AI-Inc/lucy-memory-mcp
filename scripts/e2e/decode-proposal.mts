// TEST-ONLY helper. Run through PRODUCT's installed tsx; never deployed.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [product, publicId] = process.argv.slice(2);
if (!product || !publicId) throw new Error('usage: decode-proposal.mts <product-worktree> <public-id>');
const moduleUrl = pathToFileURL(resolve(product, 'lib/lucy/domain/agent-memory-v1/proposal-id-codec.ts')).href;
const { decodeCanonicalAgentMemoryProposalId } = await import(moduleUrl);
const decoded = decodeCanonicalAgentMemoryProposalId(publicId);
if (!decoded) throw new Error('invalid canonical proposal id');
process.stdout.write(decoded);
