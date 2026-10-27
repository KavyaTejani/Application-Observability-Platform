import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginInput, RegisterInput } from '@aop/validation';
import { api, ApiError } from './api';
import type { Me } from './types';

export const ME_KEY = ['auth', 'me'] as const;

/**
 * Current session. `null` means signed out: a 401 is an expected state, not an error. The UI
 * uses this only to choose what to render; the API re-authorizes every request regardless.
 */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async ({ signal }) => {
      try {
        return await api<Me>('/auth/me', { signal });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) => api('/auth/login', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ME_KEY }),
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterInput) => api('/auth/register', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ME_KEY }),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    // Drop every cached query so no data from the previous user stays in memory.
    onSettled: () => {
      queryClient.clear();
      queryClient.setQueryData(ME_KEY, null);
    },
  });
}
