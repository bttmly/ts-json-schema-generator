import * as ts from "typescript";
import { NoRootTypeError } from "./Error/NoRootTypeError";
import { Context, NodeParser } from "./NodeParser";
import { Definition } from "./Schema/Definition";
import { Schema } from "./Schema/Schema";
import { BaseType } from "./Type/BaseType";
import { DefinitionType } from "./Type/DefinitionType";
import { TypeFormatter } from "./TypeFormatter";
import { StringMap } from "./Utils/StringMap";
import { localSymbolAtNode, symbolAtNode } from "./Utils/symbolAtNode";

export class SchemaGenerator {
    public constructor(
        public readonly program: ts.Program,
        public readonly nodeParser: NodeParser,
        public readonly typeFormatter: TypeFormatter
    ) {}

    public createSchema(fullName: string | undefined): Schema {
        const rootNodes = this.getRootNodes(fullName);
        const rootTypes = rootNodes.map(rootNode => {
            return this.nodeParser.createType(rootNode, new Context());
        });
        const rootTypeDefinition = rootTypes.length === 1 ? this.getRootTypeDefinition(rootTypes[0]) : {};
        const definitions: StringMap<Definition> = {};
        rootTypes.forEach(rootType => this.appendRootChildDefinitions(rootType, definitions));

        return { $schema: "http://json-schema.org/draft-07/schema#", ...rootTypeDefinition, definitions };
    }

    public createSchemaFromNode(node: ts.Node): Schema {
        const rootType = this.nodeParser.createType(node, new Context());
        const rootTypeDefinition = this.getRootTypeDefinition(rootType);
        const definitions: StringMap<Definition> = {};
        this.appendRootChildDefinitions(rootType, definitions);
        return { $schema: "http://json-schema.org/draft-07/schema#", ...rootTypeDefinition, definitions };
    }

    public getRootNodes(fullName: string | undefined) {
        if (fullName && fullName !== "*") {
            return [this.findNamedNode(fullName)];
        } else {
            const rootFileNames = this.program.getRootFileNames();
            const rootSourceFiles = this.program
                .getSourceFiles()
                .filter(sourceFile => rootFileNames.includes(sourceFile.fileName));
            const rootNodes = new Map<string, ts.Node>();
            this.appendTypes(rootSourceFiles, this.program.getTypeChecker(), rootNodes);
            return [...rootNodes.values()];
        }
    }
    public findNamedNode(fullName: string): ts.Node {
        const typeChecker = this.program.getTypeChecker();
        const allTypes = new Map<string, ts.Node>();
        const { projectFiles, externalFiles } = this.partitionFiles();

        this.appendTypes(projectFiles, typeChecker, allTypes);

        if (allTypes.has(fullName)) {
            return allTypes.get(fullName)!;
        }

        this.appendTypes(externalFiles, typeChecker, allTypes);

        if (allTypes.has(fullName)) {
            return allTypes.get(fullName)!;
        }

        throw new NoRootTypeError(fullName);
    }
    public getRootTypeDefinition(rootType: BaseType): Definition {
        return this.typeFormatter.getDefinition(rootType);
    }
    public appendRootChildDefinitions(rootType: BaseType, childDefinitions: StringMap<Definition>): void {
        const seen = new Set<string>();

        const children = this.typeFormatter
            .getChildren(rootType)
            .filter((child): child is DefinitionType => child instanceof DefinitionType)
            .filter(child => {
                if (!seen.has(child.getId())) {
                    seen.add(child.getId());
                    return true;
                }
                return false;
            });

        const ids = new Map<string, string>();
        for (const child of children) {
            const name = child.getName();
            const previousId = ids.get(name);
            if (previousId && child.getId() !== previousId) {
                throw new Error(`Type "${name}" has multiple definitions.`);
            }
            ids.set(name, child.getId());
        }

        children.reduce((definitions, child) => {
            const name = child.getName();
            if (!(name in definitions)) {
                definitions[name] = this.typeFormatter.getDefinition(child.getType());
            }
            return definitions;
        }, childDefinitions);
    }
    public partitionFiles() {
        const projectFiles = new Array<ts.SourceFile>();
        const externalFiles = new Array<ts.SourceFile>();

        for (const sourceFile of this.program.getSourceFiles()) {
            const destination = sourceFile.fileName.includes("/node_modules/") ? externalFiles : projectFiles;
            destination.push(sourceFile);
        }

        return { projectFiles, externalFiles };
    }
    public appendTypes(
        sourceFiles: readonly ts.SourceFile[],
        typeChecker: ts.TypeChecker,
        types: Map<string, ts.Node>
    ) {
        for (const sourceFile of sourceFiles) {
            this.inspectNode(sourceFile, typeChecker, types);
        }
    }
    public inspectNode(node: ts.Node, typeChecker: ts.TypeChecker, allTypes: Map<string, ts.Node>): void {
        switch (node.kind) {
            case ts.SyntaxKind.InterfaceDeclaration:
            case ts.SyntaxKind.ClassDeclaration:
            case ts.SyntaxKind.EnumDeclaration:
            case ts.SyntaxKind.TypeAliasDeclaration:
                if (!this.isExportType(node) || this.isGenericType(node as ts.TypeAliasDeclaration)) {
                    return;
                }

                allTypes.set(this.getFullName(node, typeChecker), node);
                break;
            default:
                ts.forEachChild(node, subnode => this.inspectNode(subnode, typeChecker, allTypes));
                break;
        }
    }
    public isExportType(node: ts.Node): boolean {
        const localSymbol = localSymbolAtNode(node);
        return localSymbol ? "exportSymbol" in localSymbol : false;
    }
    public isGenericType(node: ts.TypeAliasDeclaration): boolean {
        return !!(node.typeParameters && node.typeParameters.length > 0);
    }
    public getFullName(node: ts.Node, typeChecker: ts.TypeChecker): string {
        const symbol = symbolAtNode(node)!;
        return typeChecker.getFullyQualifiedName(symbol).replace(/".*"\./, "");
    }
}
