import path from 'path';

export default class ModuleRegistry {
    private static instance: ModuleRegistry;
    private modules: Map<string, string> = new Map<string, string>();

    private constructor() { }

    public static getInstance(): ModuleRegistry {
        if (!ModuleRegistry.instance) {
            ModuleRegistry.instance = new ModuleRegistry();
        }
        return ModuleRegistry.instance;
    }

    public registerModule(moduleName: string, modulePath: string) {
        const absolutePath = path.resolve(modulePath);
        this.modules.set(moduleName, absolutePath);
    }

    public getModulePath(moduleName: string): string | undefined {
        return this.modules.get(moduleName);
    }
}
