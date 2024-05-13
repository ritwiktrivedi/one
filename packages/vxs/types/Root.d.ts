import { type ExpoRootProps } from './ExpoRoot';
import type { GlobbedRouteImports } from './types';
type RootProps = Omit<ExpoRootProps, 'context'> & {
    routes: GlobbedRouteImports;
    path?: string;
};
export declare function Root(props: RootProps): import("react/jsx-runtime").JSX.Element;
export declare function Contents({ routes, path, ...props }: RootProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=Root.d.ts.map